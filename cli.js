#!/usr/bin/env node
// Command-line interface.
//   node cli.js fetch    --symbol BTCUSDT --interval 1d --start 2018-01-01
//   node cli.js list
//   node cli.js run      --symbol BTCUSDT --strategy donchian-breakout
//   node cli.js compare  --symbol BTCUSDT
//   node cli.js optimize --symbol BTCUSDT --strategy rsi2-meanrev
//   node cli.js signal   --symbol BTCUSDT --strategy donchian-breakout

import { fetchCandles, loadCandles, listCached, auditCandles, sliceByDate, BARS_PER_YEAR } from './lib/data.js';
import { runBacktest, buyAndHold } from './lib/engine.js';
import { computeMetrics, metricRows, pct, num, money } from './lib/metrics.js';
import { optimize, verdict } from './lib/optimize.js';
import { monteCarlo, breakevenWinRate } from './lib/montecarlo.js';
import { STRATEGIES, getStrategy } from './strategies/index.js';

// ── arg parsing ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const [k, v] = argv[++i].split('=');
      args.set[k] = Number.isNaN(+v) ? v : +v;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = Number.isNaN(+next) || next.includes('-') ? (i++, next) : (i++, +next);
    } else args._.push(a);
  }
  return args;
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;

function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => visLen(r[c] ?? ''))));
  const pad = (s, w, right) => {
    const gap = ' '.repeat(Math.max(0, w - visLen(s)));
    return right ? gap + s : s + gap;
  };
  const line = (r, right = true) =>
    '  ' + r.map((cell, c) => pad(String(cell ?? ''), widths[c], c > 0 && right)).join('   ');

  console.log(C.dim(line(headers, true)));
  console.log(C.dim('  ' + widths.map((w) => '─'.repeat(w)).join('───')));
  rows.forEach((r) => console.log(line(r)));
}

// Compact equity sparkline so you can see the SHAPE, not just the endpoints.
// Two strategies can post identical returns and feel completely different to hold.
function sparkline(values, width = 64) {
  const blocks = '▁▂▃▄▅▆▇█';
  const clean = values.filter((v) => v != null);
  if (clean.length < 2) return '';
  const step = clean.length / width;
  const sampled = Array.from({ length: width }, (_, i) => clean[Math.floor(i * step)]);
  const lo = Math.min(...sampled);
  const hi = Math.max(...sampled);
  if (hi === lo) return blocks[0].repeat(width);
  return sampled
    .map((v) => blocks[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 7.999))])
    .join('');
}

function buildConfig(args) {
  return {
    initialEquity: args.equity ?? 10_000,
    riskPct: (args.risk ?? 1) / 100,
    feePct: (args.fee ?? 0.1) / 100,
    slippagePct: (args.slippage ?? 0.05) / 100,
    maxHoldBars: args.maxhold ?? 10,
    maxPositionPct: (args.maxpos ?? 100) / 100,
    leverage: args.leverage ?? 1,
    takeProfitPct: args.tp ? args.tp / 100 : null,
  };
}

function getCandles(args) {
  const symbol = args.symbol ?? 'BTCUSDT';
  const interval = args.interval ?? '1d';
  let candles = loadCandles(symbol, interval);
  if (args.from || args.to) candles = sliceByDate(candles, args.from, args.to);
  return { symbol, interval, candles };
}

function header(title, sub) {
  console.log('\n' + C.bold(title));
  if (sub) console.log(C.dim('  ' + sub));
  console.log();
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdFetch(args) {
  const symbol = args.symbol ?? 'BTCUSDT';
  const interval = args.interval ?? '1d';
  const start = args.start ?? '2018-01-01';
  header(`Fetching ${symbol} ${interval} from ${start}`, 'source: Binance public klines');

  const candles = await fetchCandles(symbol, interval, start);
  const audit = auditCandles(candles, interval);

  console.log(`  range      ${candles[0].date} → ${candles[candles.length - 1].date}`);
  console.log(`  bars       ${audit.bars}`);
  console.log(`  gaps       ${audit.gaps === 0 ? C.green('none') : C.yellow(audit.gaps + ' missing bars')}`);
  console.log(`  zero-vol   ${audit.zeroVol === 0 ? C.green('none') : C.yellow(audit.zeroVol)}`);
  if (audit.issues.length) {
    console.log(C.red('  integrity issues:'));
    audit.issues.forEach((i) => console.log('    ' + i));
  } else {
    console.log(`  integrity  ${C.green('OHLC consistent')}`);
  }
  console.log(C.dim(`\n  cached → data/${symbol}-${interval}.json\n`));
}

function cmdList() {
  const cached = listCached();
  header('Cached datasets');
  if (!cached.length) {
    console.log(C.dim('  none yet — run:  node cli.js fetch --symbol BTCUSDT\n'));
  } else {
    table(['SYMBOL', 'INTERVAL', 'BARS', 'FROM', 'TO'],
      cached.map((c) => [c.symbol, c.interval, c.bars, c.from, c.to]));
    console.log();
  }
  header('Strategies');
  table(['NAME', 'FAMILY', 'DESCRIPTION'],
    Object.values(STRATEGIES).map((s) => [C.cyan(s.name), s.family, s.description]));
  console.log();
}

function cmdRun(args) {
  const { symbol, interval, candles } = getCandles(args);
  const strategy = getStrategy(args.strategy ?? 'donchian-breakout');
  const params = { ...strategy.defaults, ...args.set };
  const config = buildConfig(args);
  const bpy = BARS_PER_YEAR[interval] ?? 365;

  header(
    `${strategy.name}  ·  ${symbol} ${interval}`,
    `${candles[0].date} → ${candles[candles.length - 1].date}  ·  ${candles.length} bars`
  );

  console.log(C.dim('  params  ') + JSON.stringify(params));
  console.log(
    C.dim('  costs   ') +
      `${pct(config.feePct, 2)}/side fee + ${pct(config.slippagePct, 3)}/side slippage · ` +
      `risk ${pct(config.riskPct)}/trade · max hold ${config.maxHoldBars} bars\n`
  );

  const signals = strategy.signals(candles, params);
  const stratM = computeMetrics(runBacktest({ candles, signals, config }), bpy);
  const bhM = computeMetrics(buyAndHold({ candles, config }), bpy);

  const rows = metricRows(stratM);
  const bhRows = metricRows(bhM);
  table(['METRIC', strategy.name.toUpperCase(), 'BUY & HOLD'],
    rows.map((r, i) => [r[0], r[1], bhRows[i][1]]));

  const res = runBacktest({ candles, signals, config });
  console.log('\n  ' + C.dim('strategy  ') + sparkline(res.equityCurve));
  console.log('  ' + C.dim('buy&hold  ') + sparkline(buyAndHold({ candles, config }).equityCurve));

  // The comparison that matters. Returns alone are meaningless if the strategy
  // took twice the drawdown to get there.
  const better = stratM.calmar > bhM.calmar;
  console.log(
    '\n  ' +
      (better
        ? C.green('✓ Beats buy & hold on risk-adjusted return (Calmar).')
        : C.yellow('✗ Does NOT beat buy & hold on risk-adjusted return (Calmar).')) +
      C.dim(`  ${num(stratM.calmar)} vs ${num(bhM.calmar)}`)
  );

  if (args.trades) {
    console.log();
    header('Last 15 trades');
    table(['ENTRY', 'EXIT', 'BARS', 'P&L %', 'R', 'REASON'],
      res.trades.slice(-15).map((t) => [
        t.entryDate, t.exitDate, t.bars,
        t.pnl > 0 ? C.green(pct(t.pnlPct)) : C.red(pct(t.pnlPct)),
        num(t.r), t.reason,
      ]));
  }
  console.log();
}

function cmdCompare(args) {
  const { symbol, interval, candles } = getCandles(args);
  const config = buildConfig(args);
  const bpy = BARS_PER_YEAR[interval] ?? 365;

  header(
    `All strategies  ·  ${symbol} ${interval}`,
    `${candles[0].date} → ${candles[candles.length - 1].date}  ·  default params  ·  costs included`
  );

  const rows = [];
  for (const s of Object.values(STRATEGIES)) {
    const m = computeMetrics(
      runBacktest({ candles, signals: s.signals(candles, s.defaults), config }), bpy
    );
    rows.push([C.cyan(s.name), pct(m.cagr), pct(m.maxDD), num(m.sharpe), num(m.calmar),
      m.trades, pct(m.winRate), num(m.profitFactor), num(m.expectancyR)]);
  }
  const bh = computeMetrics(buyAndHold({ candles, config }), bpy);
  rows.push([C.dim('buy & hold'), pct(bh.cagr), pct(bh.maxDD), num(bh.sharpe), num(bh.calmar),
    '1', '—', '—', '—']);

  table(['STRATEGY', 'CAGR', 'MAXDD', 'SHARPE', 'CALMAR', 'TRADES', 'WIN%', 'PF', 'EXP R'], rows);
  console.log(
    C.dim('\n  Default params only — these are untuned starting points, not recommendations.') +
    C.dim('\n  Run `optimize` before believing any of them.\n')
  );
}

function cmdOptimize(args) {
  const { symbol, interval, candles } = getCandles(args);
  const strategy = getStrategy(args.strategy ?? 'donchian-breakout');
  const config = buildConfig(args);
  const bpy = BARS_PER_YEAR[interval] ?? 365;
  const objective = args.objective ?? 'calmar';
  const split = args.split ?? 0.65;

  header(
    `Optimising ${strategy.name}  ·  ${symbol} ${interval}`,
    `objective: ${objective}  ·  train/test split: ${Math.round(split * 100)}/${Math.round((1 - split) * 100)}`
  );

  const o = optimize({ candles, strategy, config, splitRatio: split, objective, barsPerYear: bpy });
  if (o.error) {
    console.log(C.red('  ' + o.error) + '\n');
    return;
  }

  console.log(`  tested ${o.combos} combinations, ${o.ranked} had enough trades to rank\n`);
  console.log(C.dim(`  train  ${o.trainRange[0]} → ${o.trainRange[1]}`));
  console.log(C.dim(`  test   ${o.testRange[0]} → ${o.testRange[1]}  (never seen during selection)\n`));

  console.log(C.bold('  Best parameters on training data'));
  console.log('  ' + JSON.stringify(o.best) + '\n');

  const t = metricRows(o.train);
  const s = metricRows(o.test);
  table(['METRIC', 'IN-SAMPLE (train)', 'OUT-OF-SAMPLE (test)'],
    t.map((r, i) => [r[0], r[1], s[i][1]]));

  console.log('\n' + C.bold('  Overfit checks'));
  const stabColor = o.stability >= 0.5 ? C.green : o.stability >= 0.3 ? C.yellow : C.red;
  const degColor = o.degradation >= 0.5 ? C.green : o.degradation >= 0.3 ? C.yellow : C.red;
  table(['CHECK', 'VALUE', 'MEANING'], [
    ['Neighbour stability', stabColor(num(o.stability)), `avg of ${o.neighbourCount} adjacent param sets ÷ peak — want > 0.5`],
    ['OOS degradation', degColor(num(o.degradation)), 'out-of-sample ÷ in-sample score — want > 0.5'],
    ['Median top-decile OOS', num(o.medianTopTest), 'median test score across best params — want > 0'],
    ['OOS trades', String(o.test.trades), 'want > 10 to mean anything'],
  ]);

  const v = verdict(o);
  const vc = v.level === 'plausible' ? C.green : v.level === 'caution' ? C.yellow : C.red;
  console.log('\n  ' + vc(C.bold(`VERDICT: ${v.level.toUpperCase()}`)));
  v.flags.forEach((f) => console.log('  ' + vc('· ') + f));
  console.log();
}

// Sweep risk-per-trade. Returns do NOT scale linearly with size: past a point,
// bigger positions compound losses faster than wins and the curve turns down.
// That peak is the "optimal f" — and you want to run at a FRACTION of it,
// because its location shifts with the next market regime.
function cmdRiskSweep(args) {
  const { symbol, interval, candles } = getCandles(args);
  const strategy = getStrategy(args.strategy ?? 'donchian-breakout');
  const params = { ...strategy.defaults, ...args.set };
  const bpy = BARS_PER_YEAR[interval] ?? 365;
  const signals = strategy.signals(candles, params);

  header(
    `Risk sweep  ·  ${strategy.name}  ·  ${symbol} ${interval}`,
    `${candles[0].date} → ${candles[candles.length - 1].date}`
  );

  const levels = [0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30];
  const rows = [];
  let best = { calmar: -Infinity };

  for (const r of levels) {
    const config = { ...buildConfig(args), riskPct: r / 100 };
    const m = computeMetrics(runBacktest({ candles, signals, config }), bpy);
    if (m.cagr > (best.cagr ?? -Infinity)) best = { risk: r, cagr: m.cagr };
    const cagrCell = m.cagr > 0 ? C.green(pct(m.cagr)) : C.red(pct(m.cagr));
    rows.push([`${r}%`, cagrCell, pct(m.maxDD), num(m.sharpe), num(m.calmar), money(m.finalEquity)]);
  }

  table(['RISK/TRADE', 'CAGR', 'MAXDD', 'SHARPE', 'CALMAR', 'FINAL'], rows);
  console.log(
    C.dim(`\n  Peak CAGR at ${best.risk}% risk/trade. `) +
    C.yellow(`Trade well below that.`) +
    C.dim(`\n  The peak is fitted to this exact history; the next regime moves it, and the\n` +
          `  right-hand side of this curve is where accounts get destroyed.\n`)
  );
}

// "What is my probability of being in profit?" — the question people mean when
// they ask for a high win rate. Bootstraps the realised trades into thousands of
// synthetic futures and reads the distribution.
function cmdMonte(args) {
  const { symbol, interval, candles } = getCandles(args);
  const strategy = getStrategy(args.strategy ?? 'donchian-breakout');
  const params = { ...strategy.defaults, ...args.set };
  const config = buildConfig(args);
  const bpy = BARS_PER_YEAR[interval] ?? 365;

  const res = runBacktest({ candles, signals: strategy.signals(candles, params), config });
  const m = computeMetrics(res, bpy);
  const rs = res.trades.map((t) => t.r);

  header(
    `Monte Carlo  ·  ${strategy.name}  ·  ${symbol} ${interval}`,
    `${res.trades.length} historical trades resampled into 10,000 futures · risk ${pct(config.riskPct)}/trade`
  );

  const payoff = Math.abs(m.avgLoss) > 0 ? m.avgWin / Math.abs(m.avgLoss) : Infinity;
  console.log(`  win rate ${pct(m.winRate)}   payoff ${num(payoff)}   ` +
    `breakeven win rate ${pct(breakevenWinRate(payoff))}   expectancy ${num(m.expectancyR)}R\n`);

  const rows = [];
  for (const n of [12, 25, 50, 100, 250]) {
    const mc = monteCarlo({ rMultiples: rs, riskPct: config.riskPct, nTrades: n, paths: 10_000, blockSize: 5 });
    const pc = mc.pProfit >= 0.8 ? C.green : mc.pProfit >= 0.5 ? C.yellow : C.red;
    rows.push([String(n), pc(pct(mc.pProfit)), pct(mc.pUp20), pct(mc.pDown20), pct(mc.pRuin, 2),
      num(mc.p05, 2) + '×', num(mc.median, 2) + '×', num(mc.p95, 2) + '×']);
  }
  table(['TRADES', 'P(PROFIT)', 'P(+20%)', 'P(-20%)', 'P(RUIN)', '5th %ile', 'MEDIAN', '95th %ile'], rows);

  console.log(C.dim(
    '\n  With POSITIVE expectancy, P(profit) rises as you take more trades.\n' +
    '  With NEGATIVE expectancy it FALLS — more trades just realises the edge against you.\n' +
    '  That is why win rate alone tells you nothing.\n'
  ));
}

// Today's actionable signal — for MANUAL execution. This is step 3 of the
// pipeline, not an order router. It tells you what the rules say; you decide.
function cmdSignal(args) {
  const { symbol, interval, candles } = getCandles(args);
  const strategy = getStrategy(args.strategy ?? 'donchian-breakout');
  const params = { ...strategy.defaults, ...args.set };
  const config = buildConfig(args);

  const signals = strategy.signals(candles, params);
  const i = candles.length - 1; // last CLOSED bar
  const last = candles[i];

  header(
    `Signal check  ·  ${strategy.name}  ·  ${symbol} ${interval}`,
    `based on the last CLOSED bar: ${last.date}`
  );

  const fires = signals.enter[i];
  const stopDist = signals.stopDist[i];
  const equity = config.initialEquity;

  if (!fires) {
    console.log('  ' + C.dim('No entry signal. Do nothing.') + '\n');
    console.log(C.dim(`  close ${last.close}  ·  next check after the ${interval} close\n`));
    return;
  }

  // Sizing uses the last close as a proxy; the real fill is the next open.
  const entry = last.close;
  const stop = entry - stopDist;
  const units = (equity * config.riskPct) / stopDist;
  const notional = Math.min(units * entry, equity * config.maxPositionPct);

  console.log('  ' + C.green(C.bold('ENTRY SIGNAL')) + '\n');
  table(['FIELD', 'VALUE'], [
    ['Direction', 'LONG (spot)'],
    ['Reference price', num(entry, 2)],
    ['Stop loss', C.red(num(stop, 2)) + C.dim(`  (−${pct(stopDist / entry)})`)],
    ['Risk per trade', `${pct(config.riskPct)} of ${money(equity)} = ${money(equity * config.riskPct)}`],
    ['Position size', `${num(units, 6)} units ≈ ${money(notional)}`],
    ['Max hold', `${config.maxHoldBars} bars`],
    ['Invalidation', `a close below ${num(stop, 2)} means the setup failed — exit, no averaging down`],
  ]);
  console.log(
    C.dim('\n  Fill at the NEXT open, not this close. Place the stop in the same session ') +
    C.dim('as the entry — an unstopped position is the one that ends accounts.\n')
  );
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

const USAGE = `
${C.bold('crypto-backtest')} — honest swing-strategy testing

  ${C.cyan('fetch')}     --symbol BTCUSDT --interval 1d --start 2018-01-01
  ${C.cyan('list')}      show cached data and available strategies
  ${C.cyan('run')}       --symbol BTCUSDT --strategy donchian-breakout [--trades]
  ${C.cyan('compare')}   --symbol BTCUSDT          all strategies, default params
  ${C.cyan('optimize')}  --symbol BTCUSDT --strategy rsi2-meanrev [--objective calmar]
  ${C.cyan('risk')}      --symbol BTCUSDT --strategy donchian-breakout   sweep risk/trade
  ${C.cyan('monte')}     --symbol BTCUSDT --strategy donchian-breakout   P(profit)
  ${C.cyan('signal')}    --symbol BTCUSDT --strategy donchian-breakout

  ${C.dim('common flags')}
    --equity 1000    --risk 2 (% per trade)   --fee 0.1   --slippage 0.05
    --maxhold 10     --from 2022-01-01        --to 2024-01-01
    --tp 15          fixed take-profit %      --leverage 3   (funding + liquidation modelled)
    --set entryLen=25 --set atrMult=3
`;

try {
  if (cmd === 'fetch') await cmdFetch(args);
  else if (cmd === 'list') cmdList();
  else if (cmd === 'run') cmdRun(args);
  else if (cmd === 'compare') cmdCompare(args);
  else if (cmd === 'optimize') cmdOptimize(args);
  else if (cmd === 'risk') cmdRiskSweep(args);
  else if (cmd === 'monte') cmdMonte(args);
  else if (cmd === 'signal') cmdSignal(args);
  else console.log(USAGE);
} catch (e) {
  console.error('\n' + C.red('  ' + e.message) + '\n');
  process.exit(1);
}
