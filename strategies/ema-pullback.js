// Trend pullback: buy the dip inside an established uptrend rather than
// chasing the breakout. Entry is the classic "pull back to the moving average
// and resume" — price closes back above the fast EMA after dipping below it.
//
// HISTORY: the first version gated entries on RSI(14) dipping below 40 while
// also requiring EMA(10) > EMA(30). Those conditions are near mutually
// exclusive — RSI(14) rarely reaches 40 before the fast EMA has already
// crossed down — and the strategy produced 2 signals in 8.7 years. If you add
// filters to this file, check the raw signal count before trusting a backtest.

import { sma, ema, atr, rsi, closes } from '../lib/indicators.js';

export default {
  name: 'ema-pullback',
  description: 'Buy the reclaim of the fast EMA inside an uptrend, ATR trailing stop',
  family: 'trend',

  defaults: {
    fast: 10,
    slow: 30,
    trendLen: 100,
    rsiLen: 14,
    maxEntryRsi: 100, // 100 = filter off; lower values demand a deeper pullback
    atrLen: 14,
    atrMult: 2.0,
  },

  grid: {
    fast: [8, 10, 13, 20],
    slow: [21, 30, 50],
    trendLen: [50, 100, 200],
    maxEntryRsi: [50, 60, 100],
    atrMult: [1.5, 2.0, 2.5, 3.0],
  },

  signals(candles, p) {
    const n = candles.length;
    const c = closes(candles);
    const fast = ema(c, p.fast);
    const slow = ema(c, p.slow);
    const trend = sma(c, p.trendLen);
    const r = rsi(c, p.rsiLen);
    const a = atr(candles, p.atrLen);

    const enter = new Array(n).fill(false);
    const exit = new Array(n).fill(false);
    const stopDist = new Array(n).fill(null);
    const trail = new Array(n).fill(null);

    for (let i = 1; i < n; i++) {
      if (a[i] == null) continue;
      stopDist[i] = a[i] * p.atrMult;
      trail[i] = c[i] - a[i] * p.atrMult;

      if (fast[i] == null || fast[i - 1] == null || slow[i] == null || trend[i] == null) continue;

      const uptrend = fast[i] > slow[i] && c[i] > trend[i];
      const pulledBack = c[i - 1] < fast[i - 1]; // dipped under the fast EMA
      const reclaimed = c[i] > fast[i]; // and closed back above it
      const rsiOk = p.maxEntryRsi >= 100 || (r[i] != null && r[i] < p.maxEntryRsi);

      if (uptrend && pulledBack && reclaimed && rsiOk) enter[i] = true;
      if (fast[i] < slow[i]) exit[i] = true;
    }

    return { enter, exit, stopDist, trail };
  },
};
