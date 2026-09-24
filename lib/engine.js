// The backtest engine.
//
// TIMING CONTRACT (the single most important thing in this file):
//   Signals are read from bar i-1 and acted on at the OPEN of bar i.
//   A strategy can only ever use information that had already happened when
//   the decision was made. If you break this, your equity curve will look
//   spectacular and lose money in production.
//
// Accounting is margin-based so leverage is modelled honestly:
//   margin  = notional / leverage
//   equity  = cash + margin + units*(price - entry) - accruedFunding
// At leverage 1 this reduces exactly to spot (cash + units*price).

/**
 * @param candles  array of {time,date,open,high,low,close,volume}
 * @param signals  {enter:bool[], exit:bool[], stopDist:(number|null)[], trail?, target?}
 * @param config   see defaults below
 */
export function runBacktest({ candles, signals, config = {} }) {
  const {
    initialEquity = 10_000,
    riskPct = 0.01, // fraction of equity risked between entry and stop
    feePct = 0.001, // per side — Binance spot taker
    slippagePct = 0.0005, // per side
    maxHoldBars = 10,
    maxPositionPct = 1.0, // cap on notional as a fraction of equity × leverage

    // Leverage. 1 = spot. >1 models an isolated-margin perpetual: the position
    // can be liquidated, and funding is charged for every bar it is held.
    leverage = 1,
    maintenanceMarginRate = 0.005, // Binance tier-1 maintenance margin
    fundingRatePerDay = 0.0003, // ~0.01% per 8h, the long-run average for longs

    // Fixed take-profit as a fraction of entry price (e.g. 0.10 = +10%).
    // null = let the trailing stop and exit signal decide.
    takeProfitPct = null,
  } = config;

  const n = candles.length;
  let cash = initialEquity;
  let pos = null;

  const trades = [];
  const equityCurve = new Array(n).fill(null);
  let barsInMarket = 0;
  let feesPaid = 0;
  let fundingPaid = 0;
  let liquidations = 0;

  const equityNow = (price) =>
    cash + (pos ? pos.margin + pos.units * (price - pos.entryPrice) - pos.funding : 0);

  const openPosition = (i, fillOpen, stopPrice) => {
    const entry = fillOpen * (1 + slippagePct);
    const stopDist = entry - stopPrice;
    if (!(stopDist > 0)) return;

    let units = (cash * riskPct) / stopDist;

    // Notional ceiling. With leverage, buying power is equity × leverage; the
    // cap must leave room for the entry fee inside it, or every capped trade is
    // rejected for insufficient cash and silently never opens.
    const capNotional = cash * maxPositionPct * leverage;
    const capUnits = capNotional / (entry * (1 + feePct));
    const sizeCapped = units > capUnits;
    if (sizeCapped) units = capUnits;

    const notional = units * entry;
    const margin = notional / leverage;
    const fee = notional * feePct;
    if (margin + fee > cash || units <= 0) return;

    // Isolated-margin liquidation price for a long.
    const liqPrice = leverage > 1 ? entry * (1 - 1 / leverage + maintenanceMarginRate) : 0;

    cash -= margin + fee;
    feesPaid += fee;

    pos = {
      entryIdx: i,
      entryPrice: entry,
      units,
      notional,
      margin,
      stop: stopPrice,
      // Take-profit precedence: an explicit --tp overrides whatever the strategy
      // wants; otherwise the strategy may express its own target as a price
      // distance, symmetric with stopDist.
      target: takeProfitPct
        ? entry * (1 + takeProfitPct)
        : signals.targetDist?.[i - 1] != null
          ? entry + signals.targetDist[i - 1]
          : null,
      liqPrice,
      riskPerUnit: stopDist,
      funding: 0,
      sizeCapped,
    };
  };

  const closePosition = (i, rawPrice, reason) => {
    const exit = reason === 'liquidation' ? rawPrice : rawPrice * (1 - slippagePct);
    const grossPnl = pos.units * (exit - pos.entryPrice);
    const exitFee = pos.units * exit * feePct;
    const entryFee = pos.notional * feePct;

    // Two different numbers, deliberately:
    //   cashDelta — what flows back to cash on top of the returned margin. The
    //               entry fee is NOT in here; it left cash when the trade opened.
    //   pnl       — what the trade actually cost or made, net of BOTH fees.
    // Reporting cashDelta as the trade P&L quietly omits half the commission
    // and inflates profit factor and expectancy.
    const cashDelta = grossPnl - exitFee - pos.funding;
    let pnl = cashDelta - entryFee;

    if (reason === 'liquidation') {
      pnl = -pos.margin;
      liquidations++;
      // Margin is gone; nothing returns to cash.
    } else {
      cash += pos.margin + cashDelta;
      feesPaid += exitFee;
    }

    trades.push({
      entryDate: candles[pos.entryIdx].date,
      exitDate: candles[i].date,
      entryPrice: pos.entryPrice,
      exitPrice: exit,
      units: pos.units,
      notional: pos.notional,
      margin: pos.margin,
      bars: i - pos.entryIdx,
      pnl,
      // Return measured against the MARGIN committed, which is what actually
      // moves the account at leverage — not against notional.
      pnlPct: pnl / pos.margin,
      priceMovePct: exit / pos.entryPrice - 1,
      r: pnl / (pos.units * pos.riskPerUnit),
      reason,
      sizeCapped: pos.sizeCapped,
    });
    pos = null;
  };

  for (let i = 1; i < n; i++) {
    const bar = candles[i];
    const s = i - 1;
    let exitedThisBar = false;

    if (pos) {
      // Funding accrues for every bar the position is held.
      if (leverage > 1) {
        const f = pos.notional * fundingRatePerDay;
        pos.funding += f;
        fundingPaid += f;
      }

      const held = i - pos.entryIdx;
      let price = null;
      let reason = null;

      if (signals.exit[s]) {
        price = bar.open;
        reason = 'signal';
      } else if (held >= maxHoldBars) {
        price = bar.open;
        reason = 'max-hold';
      } else {
        // For a long, stop and liquidation are both below entry: whichever sits
        // HIGHER is reached first. A stop only protects you while it is tighter
        // than the liquidation price — at high leverage it may not be.
        const stopFirst = pos.stop >= pos.liqPrice;
        const upper = stopFirst ? pos.stop : pos.liqPrice;
        const upperReason = stopFirst ? 'stop' : 'liquidation';

        if (bar.low <= upper) {
          price = upperReason === 'liquidation' ? pos.liqPrice : Math.min(pos.stop, bar.open);
          reason = upperReason;
        } else if (pos.target !== null && bar.high >= pos.target) {
          price = Math.max(pos.target, bar.open);
          reason = 'target';
        }
      }
      // Ordering note: the downside branch is checked BEFORE the target. When one
      // bar's range covers both, we assume the loss. Real intrabar sequence is
      // unknowable from daily data, so we take the pessimistic branch every time.

      if (price !== null) {
        closePosition(i, price, reason);
        exitedThisBar = true;
      }
    }

    if (!pos && !exitedThisBar && signals.enter[s] && signals.stopDist[s] > 0) {
      const stopPrice = bar.open * (1 + slippagePct) - signals.stopDist[s];
      openPosition(i, bar.open, stopPrice);
    }

    if (pos && signals.trail?.[i] != null) {
      pos.stop = Math.max(pos.stop, signals.trail[i]);
    }

    if (pos) barsInMarket++;
    equityCurve[i] = equityNow(bar.close);

    // A wiped account cannot trade its way back. Stop the simulation rather
    // than letting negative equity produce meaningless statistics.
    if (equityCurve[i] <= 0) {
      equityCurve[i] = 0;
      for (let j = i + 1; j < n; j++) equityCurve[j] = 0;
      break;
    }
  }

  if (pos) closePosition(n - 1, candles[n - 1].close, 'end-of-data');
  const last = equityCurve[n - 1];
  if (last !== 0) equityCurve[n - 1] = cash;
  equityCurve[0] = initialEquity;

  return {
    equityCurve,
    trades,
    finalEquity: equityCurve[n - 1],
    initialEquity,
    barsInMarket,
    feesPaid,
    fundingPaid,
    liquidations,
    candles,
  };
}

/** Buy at the first open, hold to the last close. The bar every strategy must clear. */
export function buyAndHold({ candles, config = {} }) {
  const { initialEquity = 10_000, feePct = 0.001, slippagePct = 0.0005 } = config;
  const entry = candles[0].open * (1 + slippagePct);
  const units = (initialEquity * (1 - feePct)) / entry;
  const equityCurve = candles.map((c) => units * c.close);
  const final = units * candles[candles.length - 1].close * (1 - slippagePct - feePct);

  return {
    equityCurve,
    trades: [
      {
        entryDate: candles[0].date,
        exitDate: candles[candles.length - 1].date,
        bars: candles.length,
        pnl: final - initialEquity,
        pnlPct: final / initialEquity - 1,
        r: 0,
        reason: 'hold',
      },
    ],
    finalEquity: final,
    initialEquity,
    barsInMarket: candles.length,
    feesPaid: initialEquity * feePct * 2,
    fundingPaid: 0,
    liquidations: 0,
    candles,
  };
}
