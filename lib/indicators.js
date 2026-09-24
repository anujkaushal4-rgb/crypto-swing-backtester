// Pure indicator functions. Every one returns an array the same length as the
// input, with `null` for bars where there isn't enough history yet. Nulls are
// how the engine knows to stay flat during warmup instead of trading on
// half-formed indicators.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      seed += values[i];
      continue;
    }
    if (i === period - 1) {
      seed += values[i];
      prev = seed / period; // seed the EMA with an SMA, standard practice
      out[i] = prev;
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const pc = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return out;
}

// Wilder's ATR (the original smoothing, not an EMA approximation).
export function atr(candles, period) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  let seed = 0;
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      seed += tr[i];
      if (i === period - 1) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI.
export function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Extreme over the `period` bars STRICTLY BEFORE bar i. Excluding the current
// bar is what makes a breakout test meaningful — otherwise today's high is part
// of the level today is being compared against, and everything "breaks out".
export function rollingExtremePrior(values, period, type) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let best = values[i - period];
    for (let j = i - period + 1; j < i; j++) {
      if (type === 'max' ? values[j] > best : values[j] < best) best = values[j];
    }
    out[i] = best;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j];
    mean /= period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

// Rate of change over `period` bars, as a fraction.
export function roc(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period];
    out[i] = past === 0 ? null : values[i] / past - 1;
  }
  return out;
}

export const closes = (candles) => candles.map((c) => c.close);
export const highs = (candles) => candles.map((c) => c.high);
export const lows = (candles) => candles.map((c) => c.low);
