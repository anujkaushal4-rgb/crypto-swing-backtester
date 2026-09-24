import donchian from './donchian-breakout.js';
import emaPullback from './ema-pullback.js';
import rsi2 from './rsi2-meanrev.js';
import bollinger from './bollinger-revert.js';
import highwin from './highwin-pullback.js';

export const STRATEGIES = {
  [donchian.name]: donchian,
  [emaPullback.name]: emaPullback,
  [rsi2.name]: rsi2,
  [bollinger.name]: bollinger,
};

export function getStrategy(name) {
  const s = STRATEGIES[name];
  if (!s) {
    throw new Error(
      `Unknown strategy "${name}".\n  Available: ${Object.keys(STRATEGIES).join(', ')}`
    );
  }
  return s;
}
