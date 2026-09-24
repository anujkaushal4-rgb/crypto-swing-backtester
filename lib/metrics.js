// Performance statistics computed from the daily equity curve and trade list.

function dailyReturns(equityCurve) {
  const eq = equityCurve.filter((v) => v != null);
  const rets = [];
  for (let i = 1; i < eq.length; i++) {
    if (eq[i - 1] > 0) rets.push(eq[i] / eq[i - 1] - 1);
  }
  return rets;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

function maxDrawdown(equityCurve) {
  const eq = equityCurve.filter((v) => v != null);
  let peak = eq[0];
  let maxDD = 0;
  let peakIdx = 0;
  let longest = 0;
  let curRecovery = 0;

  for (let i = 0; i < eq.length; i++) {
    if (eq[i] > peak) {
      peak = eq[i];
      peakIdx = i;
      longest = Math.max(longest, curRecovery);
      curRecovery = 0;
    } else {
      curRecovery = i - peakIdx;
      maxDD = Math.max(maxDD, (peak - eq[i]) / peak);
    }
  }
  return { maxDD, longestDrawdownBars: Math.max(longest, curRecovery) };
}

export function computeMetrics(result, barsPerYear = 365) {
  const { equityCurve, trades, initialEquity, finalEquity, barsInMarket, feesPaid } = result;
  const rets = dailyReturns(equityCurve);
  const bars = equityCurve.filter((v) => v != null).length;
  const years = bars / barsPerYear;

  const totalReturn = finalEquity / initialEquity - 1;
  // Guard against a blown account producing a complex/NaN CAGR.
  const cagr = finalEquity > 0 && years > 0 ? (finalEquity / initialEquity) ** (1 / years) - 1 : -1;

  const sd = std(rets);
  const sharpe = sd > 0 ? (mean(rets) / sd) * Math.sqrt(barsPerYear) : 0;
  const downside = rets.filter((r) => r < 0);
  const dsd = std(downside);
  const sortino = dsd > 0 ? (mean(rets) / dsd) * Math.sqrt(barsPerYear) : 0;

  const { maxDD, longestDrawdownBars } = maxDrawdown(equityCurve);
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let consec = 0;
  let maxConsecLosses = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      consec++;
      maxConsecLosses = Math.max(maxConsecLosses, consec);
    } else consec = 0;
  }

  const rs = trades.map((t) => t.r).filter((r) => Number.isFinite(r));

  return {
    totalReturn,
    cagr,
    sharpe,
    sortino,
    maxDD,
    calmar,
    longestDrawdownBars,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyR: rs.length ? mean(rs) : 0,
    avgWin: wins.length ? mean(wins.map((t) => t.pnlPct)) : 0,
    avgLoss: losses.length ? mean(losses.map((t) => t.pnlPct)) : 0,
    avgBars: trades.length ? mean(trades.map((t) => t.bars)) : 0,
    exposure: bars ? barsInMarket / bars : 0,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0,
    maxConsecLosses,
    feesPaid,
    feeDragPct: initialEquity ? feesPaid / initialEquity : 0,
    finalEquity,
    years,
  };
}

// ── formatting helpers ────────────────────────────────────────────────────────
export const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
export const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const money = (v) =>
  Number.isFinite(v) ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';

/** Metric rows shared by the `run` and `compare` views. */
export function metricRows(m) {
  return [
    ['Total return', pct(m.totalReturn)],
    ['CAGR', pct(m.cagr)],
    ['Max drawdown', pct(m.maxDD)],
    ['Sharpe', num(m.sharpe)],
    ['Sortino', num(m.sortino)],
    ['Calmar (CAGR/MaxDD)', num(m.calmar)],
    ['Longest drawdown', `${Math.round(m.longestDrawdownBars)} bars`],
    ['Trades', String(m.trades)],
    ['Win rate', pct(m.winRate)],
    ['Profit factor', num(m.profitFactor)],
    ['Expectancy', `${num(m.expectancyR)} R`],
    ['Avg win / avg loss', `${pct(m.avgWin)} / ${pct(m.avgLoss)}`],
    ['Avg hold', `${num(m.avgBars, 1)} bars`],
    ['Time in market', pct(m.exposure)],
    ['Max consecutive losses', String(m.maxConsecLosses)],
    ['Fees paid', `${money(m.feesPaid)} (${pct(m.feeDragPct)} of start)`],
    ['Final equity', money(m.finalEquity)],
  ];
}
