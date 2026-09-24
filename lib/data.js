// Candle fetching + on-disk cache. Source is Binance's public klines endpoint,
// which needs no API key and has the longest clean history for major pairs.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

export const INTERVAL_MS = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

// Crypto trades every day, so a "year" is 365 bars on the daily chart — not the
// 252 you'd use for equities. Getting this wrong inflates Sharpe by ~20%.
export const BARS_PER_YEAR = {
  '1h': 8760,
  '4h': 2190,
  '12h': 730,
  '1d': 365,
  '1w': 52,
};

const cachePath = (symbol, interval) => join(DATA_DIR, `${symbol}-${interval}.json`);

async function fetchPage(symbol, interval, startTime) {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${symbol}` +
    `&interval=${interval}&startTime=${startTime}&limit=1000`;
  const res = await fetch(url, { headers: { 'User-Agent': 'crypto-backtest/1.0' } });
  if (!res.ok) {
    throw new Error(`Binance ${res.status} for ${symbol} ${interval}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Download full history and cache it. Returns the candle array.
 * Candles are plain objects so strategy code stays readable.
 */
export async function fetchCandles(symbol, interval, startDate, { verbose = true } = {}) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Unsupported interval: ${interval}`);

  let cursor = new Date(startDate).getTime();
  if (Number.isNaN(cursor)) throw new Error(`Bad start date: ${startDate}`);

  const now = Date.now();
  const candles = [];

  while (cursor < now) {
    const page = await fetchPage(symbol, interval, cursor);
    if (!page.length) break;

    for (const k of page) {
      candles.push({
        time: k[0],
        date: new Date(k[0]).toISOString().slice(0, 10),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      });
    }

    const lastOpen = page[page.length - 1][0];
    cursor = lastOpen + step;
    if (verbose) process.stdout.write(`\r  fetched ${candles.length} bars…`);
    if (page.length < 1000) break;
    await new Promise((r) => setTimeout(r, 120)); // stay well inside rate limits
  }

  // Drop the final bar if it is still forming. A partially-built candle has a
  // close that hasn't happened yet, and backtesting on it invents an edge that
  // evaporates the moment you trade live.
  while (candles.length && candles[candles.length - 1].time + step > now) candles.pop();

  if (verbose) process.stdout.write(`\r  fetched ${candles.length} complete bars.   \n`);

  writeFileSync(
    cachePath(symbol, interval),
    JSON.stringify({ symbol, interval, source: 'binance', updated: new Date().toISOString(), candles })
  );
  return candles;
}

export function loadCandles(symbol, interval) {
  const p = cachePath(symbol, interval);
  if (!existsSync(p)) {
    throw new Error(
      `No cached data for ${symbol} ${interval}.\n  Run:  node cli.js fetch --symbol ${symbol} --interval ${interval}`
    );
  }
  return JSON.parse(readFileSync(p, 'utf8')).candles;
}

export function listCached() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const meta = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
      return {
        file: f,
        symbol: meta.symbol,
        interval: meta.interval,
        bars: meta.candles.length,
        from: meta.candles[0]?.date,
        to: meta.candles[meta.candles.length - 1]?.date,
      };
    });
}

/** Sanity-check the series before trusting any result computed from it. */
export function auditCandles(candles, interval) {
  const step = INTERVAL_MS[interval];
  const issues = [];
  let gaps = 0;
  let zeroVol = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.high < c.low) issues.push(`bar ${i} (${c.date}): high < low`);
    if (c.open <= 0 || c.close <= 0) issues.push(`bar ${i} (${c.date}): non-positive price`);
    if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      issues.push(`bar ${i} (${c.date}): OHLC inconsistent`);
    }
    if (c.volume === 0) zeroVol++;
    if (i > 0 && candles[i].time - candles[i - 1].time !== step) gaps++;
  }

  return { bars: candles.length, gaps, zeroVol, issues: issues.slice(0, 10) };
}

export function sliceByDate(candles, from, to) {
  const lo = from ? new Date(from).getTime() : -Infinity;
  const hi = to ? new Date(to).getTime() : Infinity;
  return candles.filter((c) => c.time >= lo && c.time <= hi);
}
