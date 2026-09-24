// Connors-style RSI(2) mean reversion, long-only above the long trend filter.
// Buys short-term panic inside a healthy uptrend. Expect a HIGH win rate with
// small wins — the opposite shape to the breakout strategies. The danger is the
// rare trade that keeps falling, which is why the ATR stop is non-negotiable.

import { sma, atr, rsi, closes } from '../lib/indicators.js';

export default {
  name: 'rsi2-meanrev',
  description: 'Buy RSI(2) oversold above the 200-bar trend, exit on snap-back',
  family: 'mean-reversion',

  defaults: {
    rsiLen: 2,
    entryLevel: 10,
    exitLevel: 70,
    exitSmaLen: 5,
    trendLen: 200,
    atrLen: 14,
    atrMult: 3.0,
  },

  grid: {
    rsiLen: [2, 3, 4],
    entryLevel: [5, 10, 15, 20],
    exitLevel: [60, 70, 80],
    trendLen: [100, 150, 200],
    atrMult: [2.0, 3.0, 4.0],
  },

  signals(candles, p) {
    const n = candles.length;
    const c = closes(candles);
    const r = rsi(c, p.rsiLen);
    const trend = sma(c, p.trendLen);
    const exitSma = sma(c, p.exitSmaLen);
    const a = atr(candles, p.atrLen);

    const enter = new Array(n).fill(false);
    const exit = new Array(n).fill(false);
    const stopDist = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      if (a[i] == null) continue;
      stopDist[i] = a[i] * p.atrMult;

      if (r[i] == null || trend[i] == null) continue;

      if (c[i] > trend[i] && r[i] < p.entryLevel) enter[i] = true;
      if (r[i] > p.exitLevel || (exitSma[i] != null && c[i] > exitSma[i])) exit[i] = true;
    }

    // No trailing stop: mean reversion needs room to revert. Trailing a
    // counter-trend entry stops you out at exactly the wrong moment.
    return { enter, exit, stopDist };
  },
};
