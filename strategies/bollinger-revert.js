// Bollinger band reversion: buy a stretch below the lower band while the
// long-term trend is still up, exit back at the mean. A volatility-normalised
// cousin of RSI-2 — it adapts its entry threshold as volatility expands.

import { sma, stdev, atr, closes } from '../lib/indicators.js';

export default {
  name: 'bollinger-revert',
  description: 'Buy below the lower band above the trend filter, exit at the mean',
  family: 'mean-reversion',

  defaults: {
    bbLen: 20,
    bbMult: 2.0,
    trendLen: 200,
    atrLen: 14,
    atrMult: 3.0,
  },

  grid: {
    bbLen: [10, 15, 20, 30],
    bbMult: [1.5, 2.0, 2.5, 3.0],
    trendLen: [100, 150, 200],
    atrMult: [2.0, 3.0, 4.0],
  },

  signals(candles, p) {
    const n = candles.length;
    const c = closes(candles);
    const mid = sma(c, p.bbLen);
    const sd = stdev(c, p.bbLen);
    const trend = sma(c, p.trendLen);
    const a = atr(candles, p.atrLen);

    const enter = new Array(n).fill(false);
    const exit = new Array(n).fill(false);
    const stopDist = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      if (a[i] == null) continue;
      stopDist[i] = a[i] * p.atrMult;

      if (mid[i] == null || sd[i] == null || trend[i] == null) continue;
      const lower = mid[i] - p.bbMult * sd[i];

      if (c[i] > trend[i] && c[i] < lower) enter[i] = true;
      if (c[i] > mid[i]) exit[i] = true;
    }

    return { enter, exit, stopDist };
  },
};
