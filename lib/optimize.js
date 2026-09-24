// Parameter search with overfit detection.
//
// A grid search on its own is a machine for producing lies: run enough
// combinations and one of them will look brilliant by luck alone. Two guards
// here make the output trustworthy:
//
//   1. TRAIN/TEST SPLIT — parameters are chosen on the first slice of history
//      and scored on a slice they never saw.
//   2. NEIGHBOURHOOD STABILITY — a genuine edge is a broad plateau in parameter
//      space. If the winner's neighbours are all bad, the winner is noise.

import { runBacktest } from './engine.js';
import { computeMetrics } from './metrics.js';

export function gridCombos(grid, defaults) {
  const keys = Object.keys(grid);
  let combos = [{ ...defaults }];
  for (const k of keys) {
    const next = [];
    for (const base of combos) for (const v of grid[k]) next.push({ ...base, [k]: v });
    combos = next;
  }
  return combos;
}

const OBJECTIVES = {
  calmar: (m) => m.calmar,
  sharpe: (m) => m.sharpe,
  sortino: (m) => m.sortino,
  return: (m) => m.totalReturn,
  expectancy: (m) => m.expectancyR,
  profitFactor: (m) => (Number.isFinite(m.profitFactor) ? m.profitFactor : 0),
};

function scoreOne(candles, strategy, params, config, barsPerYear) {
  const signals = strategy.signals(candles, params);
  const result = runBacktest({ candles, signals, config });
  return computeMetrics(result, barsPerYear);
}

export function optimize({
  candles,
  strategy,
  config = {},
  splitRatio = 0.65,
  objective = 'calmar',
  minTrades = 15,
  barsPerYear = 365,
}) {
  const scoreFn = OBJECTIVES[objective];
  if (!scoreFn) throw new Error(`Unknown objective "${objective}". Use: ${Object.keys(OBJECTIVES).join(', ')}`);

  const cut = Math.floor(candles.length * splitRatio);
  const train = candles.slice(0, cut);
  const test = candles.slice(cut);

  const combos = gridCombos(strategy.grid, strategy.defaults);
  const scored = [];

  for (const params of combos) {
    const m = scoreOne(train, strategy, params, config, barsPerYear);
    // A parameter set with almost no trades can post a fantastic score off two
    // lucky fills. Refuse to rank it at all.
    if (m.trades < minTrades) continue;
    scored.push({ params, score: scoreFn(m), train: m });
  }

  if (!scored.length) {
    return {
      error: `No parameter set produced at least ${minTrades} trades on the training slice. ` +
        `Either the history is too short or the entry conditions are too strict.`,
      combos: combos.length,
      trainRange: [train[0]?.date, train[train.length - 1]?.date],
      testRange: [test[0]?.date, test[test.length - 1]?.date],
    };
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // Score the winner, and the whole top decile, on unseen data.
  const bestTest = scoreOne(test, strategy, best.params, config, barsPerYear);
  const topN = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.1)));
  const topTestScores = topN.map((c) => scoreFn(scoreOne(test, strategy, c.params, config, barsPerYear)));
  const sortedTop = [...topTestScores].sort((a, b) => a - b);
  const medianTopTest = sortedTop[Math.floor(sortedTop.length / 2)];

  // Neighbourhood: every combo differing from the winner in exactly one param.
  const neighbours = scored.filter((c) => {
    const diffs = Object.keys(strategy.grid).filter((k) => c.params[k] !== best.params[k]);
    return diffs.length === 1;
  });
  const nScores = neighbours.map((c) => c.score);
  const nMean = nScores.length ? nScores.reduce((a, b) => a + b, 0) / nScores.length : 0;
  // 1.0 = neighbours as good as the peak (a plateau — trustworthy).
  // Near 0 or negative = a lone spike surrounded by rubble (overfit).
  const stability = best.score !== 0 ? nMean / best.score : 0;

  const degradation = best.score !== 0 ? scoreFn(bestTest) / best.score : 0;

  return {
    objective,
    combos: combos.length,
    ranked: scored.length,
    best: best.params,
    trainScore: best.score,
    testScore: scoreFn(bestTest),
    train: best.train,
    test: bestTest,
    stability,
    degradation,
    medianTopTest,
    neighbourCount: neighbours.length,
    trainRange: [train[0]?.date, train[train.length - 1]?.date],
    testRange: [test[0]?.date, test[test.length - 1]?.date],
    top5: scored.slice(0, 5).map((c) => ({ params: c.params, score: c.score, trades: c.train.trades })),
  };
}

/** Plain-language read on whether the optimisation result is believable. */
export function verdict(o) {
  const flags = [];
  if (o.stability < 0.5) flags.push('FRAGILE: neighbouring parameters perform far worse — likely curve-fit');
  if (o.degradation < 0.3) flags.push('DEGRADED: out-of-sample score collapsed vs in-sample');
  if (o.test.trades < 10) flags.push('THIN: too few out-of-sample trades to conclude anything');
  if (o.medianTopTest <= 0) flags.push('NEGATIVE: the median of the top parameter sets loses money out-of-sample');

  if (!flags.length) {
    return { level: 'plausible', flags: ['Holds up out-of-sample with a stable parameter neighbourhood.'] };
  }
  return { level: flags.length >= 2 ? 'reject' : 'caution', flags };
}
