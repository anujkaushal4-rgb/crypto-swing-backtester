// Minimal signed Binance REST client. Zero dependencies.
//
// Defaults to the SPOT TESTNET. Pointing this at mainnet requires an explicit,
// deliberate flag — see the guard in bot.js. The code is identical either way;
// only the base URL differs, which is exactly why the guard exists.

import crypto from 'node:crypto';

export const TESTNET_URL = 'https://testnet.binance.vision';
export const MAINNET_URL = 'https://api.binance.com';

export class BinanceClient {
  constructor({ apiKey, apiSecret, testnet = true }) {
    if (!apiKey || !apiSecret) throw new Error('apiKey and apiSecret are required');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = testnet;

    // Orders go to the configured venue.
    this.baseUrl = testnet ? TESTNET_URL : MAINNET_URL;

    // Historical candles ALWAYS come from mainnet, because the testnet only
    // serves ~11 days of daily klines. A strategy needing a 50-bar moving
    // average would find every indicator null and silently never trade — the
    // bot would look perfectly healthy and place no orders for weeks.
    // Mainnet klines are a public endpoint requiring no key. Testnet prices
    // track mainnet to ~0.002%, so signals computed on mainnet data are valid
    // for orders executed on the testnet book.
    this.dataUrl = MAINNET_URL;
    this.timeOffset = 0;
  }

  async #request(path, { method = 'GET', params = {}, signed = false, useDataUrl = false } = {}) {
    let query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    ).toString();

    if (signed) {
      // Must be an integer. Binance rejects a timestamp containing a decimal
      // point with "-1100 Illegal characters found in parameter 'timestamp'".
      const ts = Math.floor(Date.now() + this.timeOffset);
      query += `${query ? '&' : ''}timestamp=${ts}&recvWindow=10000`;
      const sig = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
      query += `&signature=${sig}`;
    }

    const url = `${useDataUrl ? this.dataUrl : this.baseUrl}${path}${query ? '?' + query : ''}`;
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey, 'User-Agent': 'crypto-backtest-bot/1.0' },
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Binance ${res.status}: non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`Binance ${res.status} ${body.code ?? ''}: ${body.msg ?? text.slice(0, 200)}`);
    }
    return body;
  }

  /**
   * Binance rejects requests whose timestamp drifts from server time.
   * The midpoint below averages two Date.now() readings, which yields a
   * fraction whenever their sum is odd — so round it. Leaving it fractional
   * makes every signed request fail on roughly half of all runs, which reads
   * as a flaky network problem rather than the arithmetic bug it is.
   */
  async syncTime() {
    const t0 = Date.now();
    const { serverTime } = await this.#request('/api/v3/time');
    this.timeOffset = Math.round(serverTime - (t0 + Date.now()) / 2);
    return this.timeOffset;
  }

  ping() {
    return this.#request('/api/v3/ping');
  }

  /** Mainnet, always — the testnet does not keep enough history to warm up indicators. */
  klines(symbol, interval, limit = 500) {
    return this.#request('/api/v3/klines', { params: { symbol, interval, limit }, useDataUrl: true });
  }

  account() {
    return this.#request('/api/v3/account', { signed: true });
  }

  exchangeInfo(symbol) {
    return this.#request('/api/v3/exchangeInfo', { params: { symbol } });
  }

  price(symbol) {
    return this.#request('/api/v3/ticker/price', { params: { symbol } });
  }

  openOrders(symbol) {
    return this.#request('/api/v3/openOrders', { params: { symbol }, signed: true });
  }

  myTrades(symbol, limit = 20) {
    return this.#request('/api/v3/myTrades', { params: { symbol, limit }, signed: true });
  }

  newOrder(params) {
    return this.#request('/api/v3/order', { method: 'POST', params, signed: true });
  }

  cancelOrder(symbol, orderId) {
    return this.#request('/api/v3/order', { method: 'DELETE', params: { symbol, orderId }, signed: true });
  }

  /** One-Cancels-Other: a take-profit limit and a stop-loss, whichever hits first. */
  newOcoOrder(params) {
    return this.#request('/api/v3/order/oco', { method: 'POST', params, signed: true });
  }

  orderList(orderListId) {
    return this.#request('/api/v3/orderList', { params: { orderListId }, signed: true });
  }

  cancelOrderList(symbol, orderListId) {
    return this.#request('/api/v3/orderList', {
      method: 'DELETE',
      params: { symbol, orderListId },
      signed: true,
    });
  }
}

// ── symbol filters ────────────────────────────────────────────────────────────
// Every exchange rejects orders that break its quantity/price granularity rules.
// Getting this wrong is the single most common reason a first live order fails.

export async function getFilters(client, symbol) {
  const info = await client.exchangeInfo(symbol);
  const s = info.symbols[0];
  const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
  return {
    symbol,
    base: s.baseAsset,
    quote: s.quoteAsset,
    stepSize: +f.LOT_SIZE.stepSize,
    minQty: +f.LOT_SIZE.minQty,
    tickSize: +f.PRICE_FILTER.tickSize,
    minNotional: +(f.NOTIONAL?.minNotional ?? f.MIN_NOTIONAL?.minNotional ?? 0),
    ocoAllowed: s.ocoAllowed,
  };
}

const decimals = (step) => {
  const s = step.toString();
  if (s.includes('e-')) return +s.split('e-')[1];
  return s.includes('.') ? s.split('.')[1].replace(/0+$/, '').length : 0;
};

/** Round DOWN to the exchange's lot step — never up, or the order can exceed balance. */
export function roundQty(qty, stepSize) {
  const d = decimals(stepSize);
  return +(Math.floor(qty / stepSize) * stepSize).toFixed(d);
}

export function roundPrice(price, tickSize) {
  const d = decimals(tickSize);
  return +(Math.round(price / tickSize) * tickSize).toFixed(d);
}
