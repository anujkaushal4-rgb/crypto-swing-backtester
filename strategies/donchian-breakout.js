// Donchian channel breakout — the Turtle archetype, shortened for swing holds.
// Buys strength: a close above the highest high of the prior N bars.
// Trend-following, so expect a LOW win rate and a few large winners carrying it.

import { sma, atr, rollingExtremePrior, closes, highs, lows } from '../lib/indicators.js';

export default {
  name: 'donchian-breakout',
  description: 'Breakout above prior N-bar high, trend-filtered, ATR trailing stop',
  family: 'trend',

  defaults: {
    entryLen: 20,
    exitLen: 10,
    atrLen: 14,
    atrMult: 2.5,
    trendLen: 100,
    useTrendFilter: 1,
  },

  grid: {
    entryLen: [10, 15, 20, 30, 40],
    exitLen: [5, 10, 15],
    atrMult: [2.0, 2.5, 3.0],
    trendLen: [50, 100, 200],
  },

  signals(candles, p) {
    const n = candles.length;
    const c = closes(candles);
    const upper = rollingExtremePrior(highs(candles), p.entryLen, 'max');
    const lower = rollingExtremePrior(lows(candles), p.exitLen, 'min');
    const trend = sma(c, p.trendLen);
    const a = atr(candles, p.atrLen);

    const enter = new Array(n).fill(false);
    const exit = new Array(n).fill(false);
    const stopDist = new Array(n).fill(null);
    const trail = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      if (a[i] == null) continue;
      stopDist[i] = a[i] * p.atrMult;
      trail[i] = c[i] - a[i] * p.atrMult;

      const trendOk = !p.useTrendFilter || (trend[i] != null && c[i] > trend[i]);
      if (upper[i] != null && c[i] > upper[i] && trendOk) enter[i] = true;
      if (lower[i] != null && c[i] < lower[i]) exit[i] = true;
    }

    return { enter, exit, stopDist, trail };
  },

  // Plain-language reason for bar i's decision, so a "no entry" in the log
  // says how far away the entry was rather than nothing at all.
  explain(candles, p, i) {
    const c = closes(candles);
    const upper = rollingExtremePrior(highs(candles), p.entryLen, 'max');
    const trend = sma(c, p.trendLen);
    if (upper[i] == null || trend[i] == null) return 'not enough history';

    const gap = (upper[i] / c[i] - 1) * 100;
    const trendUp = c[i] > trend[i];
    const breakout = c[i] > upper[i];
    return (
      `needs close > ${+upper[i].toPrecision(6)} (${p.entryLen}-bar high) — ` +
      (breakout ? 'broke out' : `${gap.toFixed(1)}% away`) +
      `; trend ${trendUp ? 'UP' : 'DOWN'} vs SMA${p.trendLen} ${+trend[i].toPrecision(6)}` +
      (!trendUp ? ' (filter blocks entries)' : '')
    );
  },
};
