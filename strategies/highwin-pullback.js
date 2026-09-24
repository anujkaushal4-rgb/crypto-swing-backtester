// A strategy built deliberately for a HIGH WIN RATE, to make the tradeoff
// visible rather than arguable.
//
// The recipe is simple and it is the same one every "90% accurate signals"
// seller uses: a WIDE stop (few losses are ever triggered) plus a SMALL target
// (most trades reach it). Win rate goes up; payoff per win goes down.
//
// The arithmetic that decides whether it actually makes money:
//
//   breakeven win rate = 1 / (1 + payoffRatio)
//   payoffRatio        = targetAtr / atrMult
//
// At the defaults below (target 1.0 ATR, stop 4.0 ATR) payoff is 0.25, so you
// need to win MORE THAN 80% of the time just to break even before fees. A 75%
// win rate here loses money. Run `node cli.js monte` to see what that does to
// the probability of actually ending up in profit.

import { sma, ema, atr, closes } from '../lib/indicators.js';

export default {
  name: 'highwin-pullback',
  description: 'Wide stop + small target for a high hit rate — study the breakeven maths',
  family: 'high-win-rate',

  defaults: {
    trendLen: 100,
    trendSlopeLen: 20,
    pullbackEma: 20,
    atrLen: 14,
    atrMult: 4.0, // wide stop  → fewer losses triggered
    targetAtr: 1.0, // small target → more wins booked
  },

  grid: {
    trendLen: [50, 100, 200],
    pullbackEma: [10, 20, 30],
    atrMult: [2.0, 3.0, 4.0, 6.0],
    targetAtr: [0.5, 1.0, 2.0, 3.0],
  },

  signals(candles, p) {
    const n = candles.length;
    const c = closes(candles);
    const trend = sma(c, p.trendLen);
    const pull = ema(c, p.pullbackEma);
    const a = atr(candles, p.atrLen);

    const enter = new Array(n).fill(false);
    const exit = new Array(n).fill(false);
    const stopDist = new Array(n).fill(null);
    const targetDist = new Array(n).fill(null);

    for (let i = 1; i < n; i++) {
      if (a[i] == null) continue;
      stopDist[i] = a[i] * p.atrMult;
      targetDist[i] = a[i] * p.targetAtr;

      const slopeRef = trend[i - p.trendSlopeLen];
      if (trend[i] == null || slopeRef == null || pull[i - 1] == null) continue;

      // Only trade with a trend that is not merely above its average but
      // actually rising — the cheapest way to avoid catching a topping market.
      const uptrend = c[i] > trend[i] && trend[i] > slopeRef;
      const pulledBack = c[i - 1] < pull[i - 1];
      const turningUp = c[i] > c[i - 1];

      if (uptrend && pulledBack && turningUp) enter[i] = true;
    }

    // No discretionary exit signal: this design lives or dies on target vs stop.
    return { enter, exit, stopDist, targetDist };
  },
};
