#!/usr/bin/env node
// Paper-trading bot — Binance SPOT TESTNET.
//
// Runs once per day, shortly after the 00:00 UTC daily close. It reads the last
// CLOSED daily candle, applies the same strategy code the backtester uses, and
// places real orders against fake money.
//
// The point is NOT to make (fake) money. It is to find out where live execution
// diverges from the backtest: fill prices, rounding, rejected orders, stops that
// trigger differently than modelled. Every one of those gaps costs real money
// later if you skip this step.
//
//   node live/bot.js              dry run — decide and log, place nothing
//   node live/bot.js --live       actually place orders on the TESTNET
//   node live/bot.js --status     show open positions and balances
//
// Kill switch: create a file named STOP in this directory and the bot exits
// without trading, whatever else is configured.

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BinanceClient, getFilters, roundQty, roundPrice, MAINNET_URL } from './client.js';
import { getStrategy } from '../strategies/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');
const STATE_PATH = join(HERE, 'state.json');
const LOG_PATH = join(HERE, 'logs', 'bot.log');
const KILL_SWITCH = join(HERE, 'STOP');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const STATUS_ONLY = args.includes('--status');
// Forces one complete round trip — market buy, OCO, cancel, market sell — so
// the order path is proven before a real signal depends on it. Without this the
// buy/OCO code stays unexecuted until the first entry fires, which could be
// weeks away and unattended.
const TEST_ORDER = args.includes('--test-order');

// Set the instant any order leaves this process. A retry is only ever safe
// while this is false — re-running after a partial execution could duplicate a
// position.
let ordersPlaced = false;

// ── logging ───────────────────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function log(msg, plain = null) {
  console.log(msg);
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const clean = (plain ?? msg).replace(/\x1b\[[0-9;]*m/g, '');
  appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${clean}\n`);
}

const loadJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const saveJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

// ── candles ───────────────────────────────────────────────────────────────────
function toCandles(klines, intervalMs) {
  const out = klines.map((k) => ({
    time: k[0],
    date: new Date(k[0]).toISOString().slice(0, 10),
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
  // Same rule as the backtester: never act on a candle that is still forming.
  const now = Date.now();
  while (out.length && out[out.length - 1].time + intervalMs > now) out.pop();
  return out;
}

// ── order-path smoke test ─────────────────────────────────────────────────────
// Proves the exact sequence a real signal will use, then returns to flat.
// Deliberately does NOT touch state.json — this is not a trade, it is a check.
async function testOrderRoundTrip(client, cfg) {
  const symbol = cfg.symbols[0];
  log('');
  log(C.bold(`Order-path test on ${symbol} — testnet, fake money`));

  const filters = await getFilters(client, symbol);
  const { price: pxStr } = await client.price(symbol);
  const px = +pxStr;

  // Smallest order the exchange will accept, with headroom — the goal is to
  // exercise the code path, not to simulate a position.
  let qty = roundQty((filters.minNotional * 3) / px, filters.stepSize);
  if (qty < filters.minQty) qty = filters.minQty;
  log(C.dim(`  price ${px}  qty ${qty}  notional $${(qty * px).toFixed(2)}  (exchange min $${filters.minNotional})`));

  let bought = null;
  let ocoId = null;
  try {
    log('  1/4  MARKET BUY …');
    ordersPlaced = true;
    const buy = await client.newOrder({ symbol, side: 'BUY', type: 'MARKET', quantity: qty });
    const filled = roundQty(+buy.executedQty, filters.stepSize);
    const avg = +buy.fills.reduce((s, f) => s + +f.price * +f.qty, 0) / +buy.executedQty;
    bought = filled;
    const slip = (avg / px - 1) * 100;
    log(C.green(`       filled ${filled} @ ${avg.toFixed(2)}`));
    log(C.dim(`       slippage vs quoted: ${slip >= 0 ? '+' : ''}${slip.toFixed(4)}%  ` +
      `(backtest models 0.050%)`));

    const stopPrice = roundPrice(avg * 0.93, filters.tickSize);
    const targetPrice = roundPrice(avg * 1.15, filters.tickSize);
    log(`  2/4  OCO  stop ${stopPrice} / target ${targetPrice} …`);
    const oco = await client.newOcoOrder({
      symbol, side: 'SELL', quantity: filled,
      price: targetPrice, stopPrice,
      stopLimitPrice: roundPrice(stopPrice * 0.995, filters.tickSize),
      stopLimitTimeInForce: 'GTC',
    });
    ocoId = oco.orderListId;
    log(C.green(`       OCO accepted, list ${ocoId}, ${oco.orders.length} legs`));

    log('  3/4  cancel OCO …');
    await client.cancelOrderList(symbol, ocoId);
    ocoId = null;
    log(C.green('       cancelled'));

    log('  4/4  MARKET SELL (return to flat) …');
    const sell = await client.newOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: filled });
    const savg = +sell.fills.reduce((s, f) => s + +f.price * +f.qty, 0) / +sell.executedQty;
    bought = null;
    log(C.green(`       sold ${filled} @ ${savg.toFixed(2)}`));

    // Report price movement and commission SEPARATELY. Commission is taken
    // from the received asset and never appears in the fill price, so a
    // price-difference figure alone understates the true cost of a round trip.
    const priceDrag = ((savg - avg) / avg) * 100;
    const fees = [...buy.fills, ...sell.fills].reduce((acc, f) => {
      acc[f.commissionAsset] = (acc[f.commissionAsset] ?? 0) + +f.commission;
      return acc;
    }, {});
    const feeStr = Object.entries(fees)
      .filter(([, v]) => v > 0)
      .map(([a, v]) => `${v} ${a}`)
      .join(' + ');
    log(C.dim(`       price drag   ${priceDrag >= 0 ? '+' : ''}${priceDrag.toFixed(4)}% (spread)`));
    log(C.dim(`       commission   ${feeStr || C.yellow('ZERO — testnet is not charging fees')}`));

    log('');
    log(C.green(C.bold('  ORDER PATH VERIFIED — buy, OCO, cancel, sell all work.')));
  } catch (e) {
    log(C.red(`\n  FAILED: ${e.message}`));
    if (ocoId) log(C.yellow(`  NOTE: OCO ${ocoId} may still be open — check with --status`));
    if (bought) log(C.yellow(`  NOTE: holding ${bought} ${filters.base} — sell manually`));
    process.exitCode = 1;
  }
  log('');
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (existsSync(KILL_SWITCH)) {
    log(C.red('KILL SWITCH present (live/STOP) — exiting without trading.'));
    process.exit(0);
  }

  if (!existsSync(CONFIG_PATH)) {
    log(C.red(`No config at ${CONFIG_PATH}`));
    log(C.dim('  cp live/config.example.json live/config.json  and add your testnet keys'));
    log(C.dim('  Get keys free at https://testnet.binance.vision (sign in with GitHub)'));
    process.exit(1);
  }

  const cfg = loadJson(CONFIG_PATH);
  const client = new BinanceClient({
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    testnet: cfg.testnet !== false,
  });

  // Guard. The only difference between paper and real money is this URL, so it
  // gets an explicit, awkward opt-in rather than a quiet config flag.
  if (client.baseUrl === MAINNET_URL) {
    if (process.env.I_UNDERSTAND_THIS_IS_REAL_MONEY !== 'yes') {
      log(C.red('REFUSING TO RUN: config points at MAINNET (real money).'));
      log(C.dim('  This bot is built for the testnet. If you have genuinely completed'));
      log(C.dim('  paper trading and intend to risk real funds, set'));
      log(C.dim('  I_UNDERSTAND_THIS_IS_REAL_MONEY=yes in the environment.'));
      process.exit(1);
    }
    log(C.red(C.bold('⚠  RUNNING AGAINST MAINNET — REAL MONEY ⚠')));
  }

  await client.syncTime();

  // Dry runs work without credentials: klines and prices are public endpoints.
  // This lets you watch the bot's decisions for days before you ever create a
  // key, which is the cheapest possible way to build trust in it.
  const hasKeys = !/^PASTE_/.test(cfg.apiKey ?? '');
  if (!hasKeys && LIVE) {
    log(C.red('--live requires real testnet keys in live/config.json'));
    process.exit(1);
  }

  // Testnet accounts are pre-loaded with 400+ tokens. Showing them all buries
  // the trading log, so report only the assets this config actually touches.
  const relevant = new Set();
  for (const s of cfg.symbols) {
    relevant.add(s.replace(/USDT$|BUSD$|USDC$/, ''));
    relevant.add(s.slice(-4) === 'USDT' ? 'USDT' : s.slice(-4));
  }

  let balances = {};
  if (hasKeys) {
    const acct = await client.account();
    balances = Object.fromEntries(
      acct.balances
        .filter((b) => relevant.has(b.asset) && (+b.free > 0 || +b.locked > 0))
        .map((b) => [b.asset, +b.free + +b.locked])
    );
  }

  log('');
  log(C.bold(`Paper bot  ·  ${client.testnet ? 'TESTNET' : C.red('MAINNET')}  ·  ${new Date().toISOString()}`));
  if (!STATUS_ONLY) {
    log(C.dim(`  mode: ${LIVE ? C.yellow('LIVE (orders will be placed)') : 'dry run (no orders)'}`));
    log(C.dim(`  sizing from configured paperEquity $${cfg.paperEquity} — NOT the testnet balance,`));
    log(C.dim(`  so results transfer to the account size you actually intend to trade.`));
    log(C.dim(`  exchange balances: ${hasKeys
      ? Object.entries(balances).map(([a, v]) => `${a} ${v.toFixed(4)}`).join(', ') || 'none'
      : 'not checked (no keys yet — public endpoints only)'}`));
  }

  const state = loadJson(STATE_PATH, { positions: {}, history: [] });
  const strategy = getStrategy(cfg.strategy);

  if (TEST_ORDER) {
    if (!hasKeys) {
      log(C.red('  --test-order needs real testnet keys'));
      process.exit(1);
    }
    if (!client.testnet) {
      log(C.red('  REFUSING: --test-order places real orders and this is not the testnet.'));
      process.exit(1);
    }
    await testOrderRoundTrip(client, cfg);
    return;
  }
  const intervalMs = { '1h': 3600000, '4h': 14400000, '1d': 86400000 }[cfg.interval] ?? 86400000;

  if (STATUS_ONLY) {
    const money = (v) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`;
    const col = (v) => (v >= 0 ? C.green : C.red)(money(v));

    const open = Object.values(state.positions);
    const closed = state.history;
    const realised = closed.reduce((s, t) => s + t.pnl, 0);

    // Live prices for anything still open.
    let unrealised = 0;
    const openRows = [];
    for (const p of open) {
      const { price } = await client.price(p.symbol);
      const now = +price;
      const pnl = (now - p.entryPrice) * p.qty;
      unrealised += pnl;
      const barsHeld = Math.floor((Date.now() - p.entryBarTime) / intervalMs) - 1;
      const riskAmt = (p.entryPrice - p.stopPrice) * p.qty;
      const rewardAmt = (p.targetPrice - p.entryPrice) * p.qty;
      openRows.push(
        `  ${C.cyan(p.symbol)}  ${p.qty} @ ${p.entryPrice.toFixed(4)}   now ${now.toFixed(4)}   ` +
          `${col(pnl)} (${(((now - p.entryPrice) / p.entryPrice) * 100).toFixed(2)}%)\n` +
          `     stop ${p.stopPrice} ${C.red(`(${money(-riskAmt)})`)}   ` +
          `target ${p.targetPrice} ${C.green(`(${money(rewardAmt)})`)}   ` +
          `held ${Math.max(0, barsHeld)}/${cfg.maxHoldBars} bars`
      );
    }

    const start = cfg.paperEquity;
    const equity = start + realised + unrealised;

    log('');
    log(C.bold('  PAPER ACCOUNT'));
    log(`    starting equity    $${start.toFixed(2)}`);
    log(`    realised P&L       ${col(realised)}  ${C.dim(`(${closed.length} closed)`)}`);
    log(`    unrealised P&L     ${col(unrealised)}  ${C.dim(`(${open.length} open)`)}`);
    log(C.dim('    ─────────────────────────────'));
    log(`    ${C.bold('current equity')}     ${C.bold(`$${equity.toFixed(2)}`)}  ` +
      `${(equity >= start ? C.green : C.red)(`${equity >= start ? '+' : ''}${(((equity - start) / start) * 100).toFixed(2)}%`)}`);

    log('');
    log(C.bold('  OPEN POSITIONS'));
    if (!openRows.length) log(C.dim('    none — waiting for a signal'));
    else openRows.forEach((r) => log(r));

    log('');
    log(C.bold('  CLOSED TRADES'));
    if (!closed.length) {
      log(C.dim('    none yet'));
    } else {
      const wins = closed.filter((t) => t.pnl > 0);
      const rs = closed.map((t) => (t.entryPrice - t.stopPrice) * t.qty).map((risk, i) => closed[i].pnl / risk);
      const avgR = rs.reduce((a, b) => a + b, 0) / rs.length;
      log(`    ${closed.length} trades   win rate ${((wins.length / closed.length) * 100).toFixed(0)}%   ` +
        `expectancy ${avgR.toFixed(2)}R   total ${col(realised)}`);
      for (const t of closed.slice(-8)) {
        log(`      ${t.exitDate}  ${t.symbol.padEnd(9)} ${col(t.pnl).padEnd(20)} ${C.dim(t.reason)}`);
      }
      log(C.dim(`\n    backtest baseline: 56% win rate, 0.19R expectancy (out-of-sample)`));
    }

    // Is the scheduler actually alive? A bot that is not running looks exactly
    // like a bot with no signals.
    log('');
    log(C.bold('  SCHEDULE'));
    try {
      const { execSync } = await import('node:child_process');
      const out = execSync('launchctl list 2>/dev/null | grep cryptobot || true').toString().trim();
      log(out
        ? `    ${C.green('loaded')}  runs 02:10 CEST daily (or on wake if the Mac was asleep)`
        : `    ${C.red('NOT LOADED')} — the bot is not scheduled. Reload with:\n` +
          `      launchctl load ~/Library/LaunchAgents/com.anujkaushal.cryptobot.plist`);
    } catch {
      log(C.dim('    could not query launchctl'));
    }
    if (existsSync(KILL_SWITCH)) log(`    ${C.red('KILL SWITCH ACTIVE')} — remove live/STOP to resume`);
    try {
      const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n');
      log(C.dim(`    last activity  ${lines[lines.length - 1].slice(0, 19).replace('T', ' ')} UTC`));
    } catch {}
    log('');
    return;
  }

  for (const symbol of cfg.symbols) {
    log('');
    log(C.cyan(`── ${symbol} ──`));

    const filters = await getFilters(client, symbol);
    const candles = toCandles(await client.klines(symbol, cfg.interval, 500), intervalMs);
    const last = candles[candles.length - 1];
    const signals = strategy.signals(candles, cfg.params);
    const i = candles.length - 1;

    log(C.dim(`  last closed bar ${last.date}  close ${last.close}`));

    const pos = state.positions[symbol];

    // ── manage an open position ───────────────────────────────────────────────
    if (pos) {
      const barsHeld = candles.filter((c) => c.time > pos.entryBarTime).length;
      log(C.dim(`  open position: qty ${pos.qty} @ ${pos.entryPrice}, held ${barsHeld} bars`));

      // Did the exchange close it for us while we were away?
      let closedByExchange = false;
      if (pos.ocoListId && LIVE) {
        try {
          const ol = await client.orderList(pos.ocoListId);
          if (ol.listOrderStatus === 'ALL_DONE') closedByExchange = true;
        } catch (e) {
          log(C.yellow(`  could not query OCO ${pos.ocoListId}: ${e.message}`));
        }
      }

      if (closedByExchange) {
        const trades = await client.myTrades(symbol, 10);
        const sell = trades.reverse().find((t) => !t.isBuyer);
        const exitPrice = sell ? +sell.price : last.close;
        const pnl = (exitPrice - pos.entryPrice) * pos.qty;
        log((pnl >= 0 ? C.green : C.red)(
          `  CLOSED by exchange at ${exitPrice}  P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
        state.history.push({ ...pos, exitPrice, exitDate: last.date, pnl, reason: 'oco' });
        delete state.positions[symbol];
      } else {
        const wantExit = signals.exit[i] || barsHeld >= cfg.maxHoldBars;
        if (wantExit) {
          const reason = signals.exit[i] ? 'exit-signal' : 'max-hold';
          log(C.yellow(`  EXIT (${reason}) — market sell ${pos.qty}`));
          if (LIVE) {
            if (pos.ocoListId) {
              try {
                await client.cancelOrderList(symbol, pos.ocoListId);
              } catch (e) {
                log(C.dim(`    OCO already gone: ${e.message}`));
              }
            }
            ordersPlaced = true;
            const order = await client.newOrder({
              symbol, side: 'SELL', type: 'MARKET', quantity: pos.qty,
            });
            const exitPrice = +order.fills?.[0]?.price || last.close;
            const pnl = (exitPrice - pos.entryPrice) * pos.qty;
            log((pnl >= 0 ? C.green : C.red)(
              `    filled at ${exitPrice}  P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
            state.history.push({ ...pos, exitPrice, exitDate: last.date, pnl, reason });
            delete state.positions[symbol];
          }
        } else {
          log(C.dim('  holding — no exit condition met'));
        }
      }
    }

    // ── consider a new entry ──────────────────────────────────────────────────
    if (!state.positions[symbol]) {
      const openCount = Object.keys(state.positions).length;
      if (!signals.enter[i]) {
        log(C.dim('  no entry signal'));
        const why = strategy.explain?.(candles, cfg.params, i);
        if (why) log(C.dim(`    ${why}`));
      } else if (openCount >= cfg.maxOpenPositions) {
        log(C.yellow(`  entry signal, but already at maxOpenPositions (${cfg.maxOpenPositions})`));
      } else {
        const stopDist = signals.stopDist[i];
        const { price: pxStr } = await client.price(symbol);
        const px = +pxStr;
        const stopPrice = roundPrice(px - stopDist, filters.tickSize);
        const targetPrice = cfg.takeProfitPct
          ? roundPrice(px * (1 + cfg.takeProfitPct), filters.tickSize)
          : roundPrice(px + stopDist * cfg.targetRMultiple, filters.tickSize);

        // Identical sizing rule to the backtester: risk a fixed fraction of
        // equity across the distance to the stop.
        let qty = (cfg.paperEquity * cfg.riskPct) / stopDist;
        const capQty = (cfg.paperEquity * cfg.maxPositionPct) / px;
        if (qty > capQty) qty = capQty;
        qty = roundQty(qty, filters.stepSize);
        const notional = qty * px;

        log(C.green(`  ENTRY SIGNAL`));
        log(`    price ${px}  stop ${stopPrice} (-${(((px - stopPrice) / px) * 100).toFixed(1)}%)  ` +
          `target ${targetPrice} (+${(((targetPrice - px) / px) * 100).toFixed(1)}%)`);
        log(`    qty ${qty}  notional $${notional.toFixed(2)}  ` +
          `risk $${(cfg.paperEquity * cfg.riskPct).toFixed(2)}`);

        if (qty < filters.minQty || notional < filters.minNotional) {
          log(C.red(`    SKIPPED: below exchange minimum ` +
            `(minQty ${filters.minQty}, minNotional $${filters.minNotional})`));
        } else if (!LIVE) {
          log(C.dim('    dry run — no order placed'));
        } else {
          ordersPlaced = true;
          const buy = await client.newOrder({ symbol, side: 'BUY', type: 'MARKET', quantity: qty });
          const fillPrice =
            +buy.fills?.reduce((s, f) => s + +f.price * +f.qty, 0) / +buy.executedQty || px;
          const filledQty = roundQty(+buy.executedQty, filters.stepSize);
          log(C.green(`    BUY filled ${filledQty} @ ${fillPrice.toFixed(2)}`));
          log(C.dim(`    backtest assumed ${px} — slippage ` +
            `${(((fillPrice - px) / px) * 100).toFixed(3)}%`));

          // Resting OCO so the stop is honoured intraday, the way the backtest
          // assumes. Without it, a daily-cadence bot would only notice a blown
          // stop the next morning.
          let ocoListId = null;
          try {
            const oco = await client.newOcoOrder({
              symbol,
              side: 'SELL',
              quantity: filledQty,
              price: targetPrice,
              stopPrice,
              stopLimitPrice: roundPrice(stopPrice * 0.995, filters.tickSize),
              stopLimitTimeInForce: 'GTC',
            });
            ocoListId = oco.orderListId;
            log(C.dim(`    OCO placed (list ${ocoListId}): stop ${stopPrice} / target ${targetPrice}`));
          } catch (e) {
            log(C.red(`    OCO FAILED: ${e.message}`));
            log(C.yellow('    position is UNPROTECTED — the bot will exit it on the next run'));
          }

          state.positions[symbol] = {
            symbol,
            entryDate: last.date,
            entryBarTime: last.time,
            entryPrice: fillPrice,
            qty: filledQty,
            stopPrice,
            targetPrice,
            ocoListId,
          };
        }
      }
    }
  }

  saveJson(STATE_PATH, state);
  log('');
  log(C.dim(`  state → live/state.json   log → live/logs/bot.log`));
  log('');
}

// The overnight failure mode that actually happened: launchd fires at 02:10,
// the Mac wakes, and Wi-Fi has not reassociated yet — fetch throws instantly and
// the whole day's run is lost. A single attempt at a fixed time is not enough on
// a laptop. Retry while no order has been placed.
const TRANSIENT =
  /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|getaddrinfo/i;

async function runWithRetry(attempts = 6, delayMs = 60_000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await main();
      return;
    } catch (e) {
      const canRetry = TRANSIENT.test(e.message) && !ordersPlaced && i < attempts;
      if (!canRetry) {
        log(C.red(`\nFATAL: ${e.message}\n`));
        if (ordersPlaced) {
          log(C.yellow('  An order WAS placed before this failure — run --status before rerunning.\n'));
        }
        process.exit(1);
      }
      log(C.yellow(`  attempt ${i}/${attempts} failed: ${e.message} — retrying in ${delayMs / 1000}s`));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

runWithRetry();
