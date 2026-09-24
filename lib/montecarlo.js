// Monte Carlo bootstrap over realised trades.
//
// "What is my probability of being in profit?" is a different question from
// "what is my win rate?", and it is the one that actually matters. A strategy
// that wins 85% of trades can still have a low probability of ending a year up,
// because the 15% are large enough to swamp the rest.
//
// Method: resample the historical R-multiples (with replacement) into many
// synthetic trade sequences, compound each at the chosen risk fraction, and
// read the distribution of outcomes.
//
// LIMITATION worth knowing: an i.i.d. bootstrap assumes trades are independent.
// They are not — trend-following wins arrive in clusters, and clustering makes
// drawdowns deeper than the i.i.d. model suggests. Pass blockSize > 1 to
// resample contiguous runs of trades and retain some of that structure.

function samplePath(rs, nTrades, blockSize) {
  const out = [];
  while (out.length < nTrades) {
    const start = Math.floor(Math.random() * rs.length);
    const len = blockSize === 1 ? 1 : Math.min(blockSize, nTrades - out.length);
    for (let k = 0; k < len; k++) out.push(rs[(start + k) % rs.length]);
  }
  return out;
}

export function monteCarlo({
  rMultiples,
  riskPct = 0.02,
  nTrades = 50,
  paths = 10_000,
  blockSize = 1,
}) {
  const rs = rMultiples.filter((r) => Number.isFinite(r));
  if (rs.length < 5) return { error: 'need at least 5 trades to bootstrap' };

  const finals = [];
  let ruin = 0;
  let profitable = 0;
  let up20 = 0;
  let down20 = 0;
  let down50 = 0;
  let sumMaxDD = 0;

  for (let p = 0; p < paths; p++) {
    let equity = 1;
    let peak = 1;
    let maxDD = 0;
    let dead = false;

    for (const r of samplePath(rs, nTrades, blockSize)) {
      equity *= 1 + r * riskPct;
      if (equity <= 0.02) {
        // Below ~2% of starting capital there is no coming back; treat as ruin
        // rather than letting the geometric series produce fantasy recoveries.
        equity = 0;
        dead = true;
        break;
      }
      if (equity > peak) peak = equity;
      maxDD = Math.max(maxDD, (peak - equity) / peak);
    }

    finals.push(equity);
    sumMaxDD += maxDD;
    if (dead) ruin++;
    if (equity > 1) profitable++;
    if (equity >= 1.2) up20++;
    if (equity <= 0.8) down20++;
    if (equity <= 0.5) down50++;
  }

  finals.sort((a, b) => a - b);
  const q = (f) => finals[Math.floor(f * (finals.length - 1))];

  return {
    nTrades,
    paths,
    riskPct,
    blockSize,
    sampleTrades: rs.length,
    pProfit: profitable / paths,
    pUp20: up20 / paths,
    pDown20: down20 / paths,
    pDown50: down50 / paths,
    pRuin: ruin / paths,
    median: q(0.5),
    p05: q(0.05),
    p25: q(0.25),
    p75: q(0.75),
    p95: q(0.95),
    avgMaxDD: sumMaxDD / paths,
  };
}

/** Breakeven win rate implied by a payoff ratio (avg win ÷ avg loss). */
export const breakevenWinRate = (payoffRatio) => 1 / (1 + payoffRatio);
