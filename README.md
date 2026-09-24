# crypto-backtest

Zero-dependency swing-trading backtester for crypto. Node 18+, no `npm install`.

Built to answer one question honestly: **does this strategy have an edge after
costs, on data it has never seen?** Most backtesters are optimism machines. The
defaults here are deliberately pessimistic.

```bash
node cli.js fetch --symbol BTCUSDT --interval 1d --start 2018-01-01
node cli.js compare  --symbol BTCUSDT
node cli.js optimize --symbol BTCUSDT --strategy donchian-breakout
node cli.js risk     --symbol BTCUSDT --strategy donchian-breakout
node cli.js signal   --symbol BTCUSDT --strategy donchian-breakout
```

---

## Findings so far (BTCUSDT daily, 2018-01-01 → 2026-09-18, 3183 bars)

Four strategies, 65/35 train/test split, 0.1% fee + 0.05% slippage per side.

| Strategy | Family | OOS expectancy | Verdict |
|---|---|---|---|
| `donchian-breakout` | trend | **+0.19 R** | **PLAUSIBLE** |
| `ema-pullback` | trend | +0.14 R | CAUTION — OOS degradation 0.23 |
| `rsi2-meanrev` | mean-reversion | **−0.05 R** | REJECT — fragile + degraded |
| `bollinger-revert` | mean-reversion | +0.05 R | REJECT — fragile + degraded |

**Both mean-reversion strategies failed out-of-sample.** They look respectable
in-sample and fall apart on unseen data. In crypto, buying dips works until the
dip does not stop.

### The one that survived

`donchian-breakout` with `entryLen=15, exitLen=15, atrMult=3, trendLen=50`:

|  | In-sample | Out-of-sample |
|---|---|---|
| CAGR (2% risk/trade) | 7.6% | 4.0% |
| Max drawdown | 5.9% | 5.3% |
| Sharpe | 1.23 | 0.72 |
| Profit factor | 2.49 | 1.75 |
| Expectancy | 0.41 R | 0.19 R |
| Win rate | 54.7% | 56.3% |
| Trades | 53 | 32 |

Overfit checks: neighbour stability 0.65, OOS degradation 0.58, median
top-decile OOS 0.75. All pass.

**Cross-asset validation** — BTC-tuned parameters applied untouched:

| Asset | Profit factor | Expectancy | Win rate |
|---|---|---|---|
| BTCUSDT | 2.11 | +0.32 R | 54.7% |
| ETHUSDT | 1.52 | +0.18 R | 53.6% |
| SOLUSDT | 3.03 | +0.44 R | 60.0% |

Parameters fitted on one asset working on two others is the strongest
robustness signal in this repo.

### Two numbers that matter more than the returns

- **Longest drawdown: ~690 bars (≈ 22 months).** Nearly two years without a new
  equity high, while buy-and-hold holders posted screenshots. This, not the
  maths, is what ends most systematic trading.
- **Peak CAGR sits at 5% risk/trade — and turns negative past 7%.** Size is not
  a free dial. See `node cli.js risk`.

---

## Take-profit, risk sizing and leverage — measured, not asserted

Tested on BTCUSDT with the surviving parameters, $1,000 account.

### Fixed take-profit costs you money below +15%

| Exit rule | Win rate | Avg win | Expectancy | Final ($1k, 8.7y) |
|---|---|---|---|---|
| Trailing stop (baseline) | 55% | +11.1% | **0.32 R** | $1,682 |
| Close at +10% | **59%** | +7.5% | **0.16 R** | $1,418 |
| Close at +15% | 59% | +9.4% | 0.27 R | $1,685 |
| Close at +25% | 56% | +11.0% | 0.33 R | $1,758 |

Closing at +10% **halves the edge** while *raising* the win rate to 59%. That is
the trap: it feels better and earns less. Losers still run to the full ATR stop
(−7%), so capping winners at +10% inverts the asymmetry the strategy depends on.
+15% is roughly neutral and is an acceptable compromise if a fixed target helps
you actually follow the system.

### Risk per trade: 10% is not a safe ceiling

| Risk/trade | CAGR | Max DD | Profit factor | Expectancy |
|---|---|---|---|---|
| 2% | 6.1% | 5.9% | 2.11 | 0.32 R |
| 3% | 9.2% | 8.8% | 2.06 | 0.32 R |
| 5% | 15.0% | 14.5% | 1.96 | 0.32 R |
| 7% | 15.2% | 20.1% | 1.72 | 0.25 R |
| **10%** | **6.3%** | **28.5%** | **1.19** | **0.14 R** |

At 10% risk you get the *same CAGR as 2%* with **five times the drawdown**, and
profit factor collapses from 2.11 to 1.19. Expectancy degrades because larger
positions compound losses faster than wins. Professional discretionary sizing is
0.5–2%; 10% is deep into the destructive half of the curve, not a safety cap.

### Leverage does nothing here except cost money

With **risk-based sizing, position size is set by the stop distance, not by
available leverage.** At 2% risk and a ~7% ATR stop, notional is ~29% of equity —
so 2x, 3x and 5x produce *identical* trades:

| Leverage | Final ($1k) | Expectancy | Liquidations |
|---|---|---|---|
| 1x | $1,682 | 0.32 R | 0 |
| 2x | $1,610 | 0.29 R | 0 |
| 3x | $1,610 | 0.29 R | 0 |
| 5x | $1,610 | 0.29 R | 0 |

The $72 difference is pure funding cost. Leverage only changes anything once
risk% is high enough that notional exceeds equity — i.e. only in the regime the
table above already shows to be destructive. **Raising risk% at 1x is strictly
more efficient than adding leverage**: 5% risk at 1x returned 9.6% CAGR for
12.4% DD out-of-sample, versus 15.3% CAGR for 22.4% DD at 10% risk + 3x.

### The liquidation tail the backtest cannot show

Zero liquidations occurred above, because the ~7% ATR stop always triggers long
before the 3x liquidation threshold at −32.8%. That is true *only while stops
fill as modelled*. BTC history since 2018 contains **two single-day moves that
breach 3x liquidation**:

- **2020-03-12: −44.4%**
- **2018-01-16: −33.3%**

During those cascades order books emptied and stops filled far worse than
posted. No backtest models that. At **2x** the threshold is −49.5%, which has
never been breached — the honest gap between 2x and 3x is larger than it looks.

One point in crypto's favour: worst overnight gap since 2018 is **−0.3%**,
because it trades 24/7. Gap risk is negligible; intraday cascade risk is not.

### On a $1,000 account

Out-of-sample (2023-08-31 → 2026-09-18, 3.1 years):

| Configuration | Profit | Max DD | Profit factor |
|---|---|---|---|
| 2% risk, 1x, trailing | +$126 | 5.3% | 1.75 |
| **3% risk, 1x, TP +15%** | **+$252** | **7.0%** | **1.91** |
| 5% risk, 1x, trailing | +$324 | 12.4% | 1.69 |
| 10% risk, 3x, TP +10% | +$544 | 22.4% | 1.50 |

The aggressive configuration did make more money — but its edge per trade is
*lower* (0.15 R vs 0.19 R). The extra return is bought with risk, not skill, and
it survived only because no cascade occurred in that particular window.

Also note **fees are 9% of a $1,000 starting balance over 8.7 years**. Small
accounts pay a structurally higher share of costs.

---

## What this does NOT tell you

Read this section before risking money.

1. **Backtest ≠ live.** Plan on roughly half the backtested performance. Every
   modelling choice here is an approximation of a messier reality.
2. **Survivorship bias.** BTC, ETH and SOL all survived to 2026. The strategy
   was never tested on the coins that went to zero, and its trend filter would
   not have saved you from every one of them.
3. **Costs are assumed, not measured.** 0.1% fee + 0.05% slippage suits liquid
   majors. On thin alts, slippage alone can exceed the entire edge.
4. **Long-only spot.** No shorting, no leverage, no funding costs. In a bear
   market the strategy sits in cash — which is the point, but it means these
   results cannot be compared to a long/short system.
5. **One asset at a time.** No portfolio construction, no correlation handling.
   Running this on 5 coins at once is not 5× the edge — crypto correlations go
   to 1 exactly when you need them not to.
6. **Regime dependence.** 2018–2026 covers two cycles. It does not cover
   whatever comes next.

---

## Design: how the engine avoids lying to you

| Trap | Handling |
|---|---|
| Lookahead bias | Signals read from bar `i-1`, filled at bar `i` **open**. Never same-bar. |
| Free trading | Fee **per side** + slippage on every fill, configurable. |
| Optimistic intrabar fills | Bar hits stop *and* target → **stop assumed first**, always. |
| Gap fills | Gapping through a stop fills at the **open**, not the stop price. |
| Forming candles | Final incomplete bar is dropped at fetch time. |
| Warmup contamination | Indicators return `null` until fully formed; engine stays flat. |
| Beating nothing | Every run benchmarked against buy & hold. |
| Curve-fitting | Train/test split + neighbour-stability + top-decile OOS median. |
| Lucky-few-trades | Parameter sets with `< minTrades` are not ranked at all. |

### Position sizing

`units = (equity × riskPct) / stopDistance`, capped at `maxPositionPct` of
equity. Risk is defined as the distance from entry to stop — so a wide ATR stop
automatically gets a smaller position. Trades are reported in **R-multiples**
(profit ÷ risk taken), the only way to compare trades of different sizes.

---

## Commands

| Command | Purpose |
|---|---|
| `fetch` | Download + cache Binance klines, with an integrity audit |
| `list` | Show cached datasets and available strategies |
| `run` | Backtest one strategy vs buy & hold (`--trades` for the trade log) |
| `compare` | All strategies side by side, default params |
| `optimize` | Grid search with train/test split and overfit verdict |
| `risk` | Sweep risk-per-trade to find where sizing turns destructive |
| `signal` | What the rules say about the last closed bar — for manual execution |

Common flags: `--equity 10000 --risk 2 --fee 0.1 --slippage 0.05 --maxhold 10
--from 2022-01-01 --to 2024-01-01 --set entryLen=25`

---

## Adding a strategy

Drop a file in `strategies/`, export a default object, register it in
`strategies/index.js`:

```js
export default {
  name: 'my-strategy',
  description: '...',
  family: 'trend',
  defaults: { lookback: 20, atrMult: 2.5 },
  grid:     { lookback: [10, 20, 30], atrMult: [2, 2.5, 3] },
  signals(candles, p) {
    // return arrays aligned to candles
    return { enter, exit, stopDist, trail /* optional */, target /* optional */ };
  },
};
```

**Before trusting any backtest of a new strategy, count its raw signals.**
The original `ema-pullback` here demanded an established uptrend *and* RSI(14)
below 40 — conditions that almost never co-occur. It produced 2 signals in 8.7
years and a "100% win rate". A signal count catches that instantly; a metrics
table does not.

```js
const sig = strategy.signals(candles, strategy.defaults);
console.log(sig.enter.filter(Boolean).length, 'entry signals');
```

---

## Win rate is the wrong target

A high win rate is trivial to manufacture: widen the stop, tighten the target.
`highwin-pullback` exists to make the cost visible.

| Stop / target | Win rate | Payoff | Breakeven win rate needed | Expectancy | Result |
|---|---|---|---|---|---|
| 6 ATR / 0.5 ATR | **70.8%** | 0.08 | 92.3% | **−0.026 R** | loses money |
| 4 ATR / 1 ATR | 63.7% | 0.25 | 80.0% | 0.001 R | breaks even |
| 3 ATR / 2 ATR | 57.7% | 0.67 | 60.0% | 0.077 R | loses after fees |
| 2 ATR / 4 ATR | 50.0% | 2.00 | 33.3% | **0.116 R** | profitable |

The **highest win rate in the table is the biggest loser.** With a payoff of
0.08 you need to win 92% of the time to break even; winning 71% bleeds out.

What you actually want is **probability of being in profit**, which is a
different quantity. `node cli.js monte` bootstraps the realised trades into
10,000 synthetic futures:

| Strategy | Win rate | Expectancy | P(profit) @12 | @25 | @50 | @100 |
|---|---|---|---|---|---|---|
| highwin 6ATR/0.5ATR | **71%** | −0.03 R | 41% | 31% | 21% | **12%** |
| highwin 3ATR/2ATR | 58% | 0.08 R | 71% | 78% | 87% | 94% |
| **donchian-breakout** | **55%** | **0.32 R** | **88%** | **96%** | **99%** | **100%** |

The strategy with the **lowest win rate has the highest probability of profit.**

And note the direction of travel: with positive expectancy, P(profit) *rises*
with more trades. With negative expectancy it *falls* — 41% → 12% — because
more trades simply realise the edge against you. Trading more often cannot fix
a negative edge; it accelerates it.

### So what is ideal?

```
strategy    donchian-breakout
params      entryLen=15  exitLen=15  atrMult=3  trendLen=50
risk        3% per trade
leverage    1x (none)
exit        trailing stop  (or fixed +15% if you need a target to follow it)
max hold    10 bars
symbols     BTCUSDT, ETHUSDT — the cross-validated ones
```

55% win rate, 1.57 payoff, 0.32 R expectancy, **96% probability of profit after
25 trades**. At ~11 trades/year/symbol on two symbols, 25 trades is about a year.

---

## Paper trading — `live/`

A bot that runs the same strategy code against the **Binance Spot Testnet**:
real API, real order types, fake money.

```bash
cp live/config.example.json live/config.json   # add testnet keys
node live/bot.js            # dry run — decides and logs, places nothing
node live/bot.js --live     # actually place orders on the testnet
node live/bot.js --status   # open positions, P&L, win rate so far
```

Free testnet keys: <https://testnet.binance.vision> (sign in with GitHub).
Dry runs need **no keys at all** — klines and prices are public — so you can
watch its decisions for a week before creating one.

### Architecture note that cost an afternoon to find

**Market data comes from mainnet; orders go to the testnet.**

The testnet serves only **~11 days** of daily klines. The strategy needs ~65
bars to warm up an SMA-50, a Donchian-15 and an ATR-14. Run it on testnet
candles and every indicator is `null` forever: the bot looks perfectly healthy,
logs "no entry signal" every day, and places nothing for eight weeks.

Mainnet klines are public and need no key, and testnet prices track mainnet to
~0.002%, so signals computed on mainnet data are valid for testnet execution.
Verified: 499 candles compared, 0 mismatched; 439 signal bars, 0 differences
against the backtester.

### Safety

| Guard | Behaviour |
|---|---|
| Dry run by default | `--live` required before any order is placed |
| Kill switch | `touch live/STOP` — bot exits without trading |
| Mainnet guard | Refuses to run against real money unless `I_UNDERSTAND_THIS_IS_REAL_MONEY=yes` |
| Position cap | `maxOpenPositions` across all symbols |
| Resting OCO | Stop + target sit on the exchange, so a stop is honoured intraday rather than the next morning |
| Exchange minimums | Order rejected locally if below `minQty` / `minNotional` |
| Secrets | `live/config.json` is gitignored |

`paperEquity` drives position sizing, **not** the testnet balance — testnet
hands you a large fake balance that would let you "trade" $50k and learn
nothing. Set it to what you actually intend to trade.

### Run it daily — use launchd, not cron

Installed at `~/Library/LaunchAgents/com.anujkaushal.cryptobot.plist`, firing at
**02:10 CEST (00:10 UTC)**, ten minutes after the daily candle closes.

**Do not use cron for this on a laptop.** Cron silently skips jobs scheduled
while the machine is asleep, and 02:10 is exactly when it will be. You would get
no trades for days with nothing in the log to explain it. `launchd` runs a missed
`StartCalendarInterval` job when the machine next wakes.

```bash
launchctl list | grep cryptobot                      # is it registered?
launchctl kickstart -k gui/$(id -u)/com.anujkaushal.cryptobot   # run it now
tail -f live/logs/launchd.log                        # watch it
launchctl unload ~/Library/LaunchAgents/com.anujkaushal.cryptobot.plist  # stop it
```

**Timing drift to watch.** If the Mac is asleep at 02:10 the job runs on wake —
maybe 09:00 — so the entry happens hours after the close the signal came from,
at a different price than the backtest assumed. For a 2–10 day hold this is
minor, but it is a real deviation: the bot logs assumed vs actual fill on every
entry, so check whether the gap stays near the 0.05% modelled.

### Prove the order path before you need it

```bash
node live/bot.js --test-order
```

Forces one complete round trip on the testnet — market buy → OCO → cancel →
market sell → flat. Without it, the buy/OCO code stays unexecuted until the
first real signal, which could be weeks away and unattended. Verified working:
OCO accepted with 2 legs, cancelled cleanly, position returned to flat.

### What paper trading is actually testing

Not whether the strategy works — the backtest already estimated that. It tests
whether **your code** works: rounding, rejected orders, OCO behaviour, signed
request formatting, what happens when the bot misses a day.

It found three bugs the backtest could not:

1. A strategy whose filters never co-occurred (2 signals in 8.7 years).
2. A position cap that silently skipped every capped trade.
3. `syncTime()` producing a **fractional** timestamp, rejected by Binance with
   `-1100 Illegal characters` on roughly **half of all runs** — indistinguishable
   from a flaky network until you look at the arithmetic.

### What paper trading CANNOT tell you

**Testnet has no spread and no slippage.** Measured on a live round trip: fills
land at exactly the quoted price, price drag 0.0000%. Commission is charged
correctly at 0.1% per side, but real Binance market orders cross a spread that
the testnet does not simulate.

So paper P&L will be **optimistic by roughly the 0.05%/side the backtest
models** — and the testnet cannot validate that figure. Treat paper results as
a test of the *plumbing*, never as a forecast of returns. The first real trades,
at minimum size, are the only place slippage gets measured honestly.

---

## Roadmap — the gates before real money

```
1. BACKTEST        ✅ donchian-breakout passes, cross-validates on ETH/SOL
2. PAPER (testnet) 🔨 bot built and verified — needs 4–8 weeks of actual running
                      → does live execution match the backtest?
3. SIGNALS         ⬜ daily scan, manual order placement, 20+ trades
                      → do you actually follow it under pressure?
4. AUTOMATED       ⬜ bot executes with hard caps + kill switch
```

Gate 2 is built, not passed. Passing it means ~20 paper trades where realised
slippage stays near the 0.05% modelled and no order is rejected for a reason the
code did not anticipate.

Skipping a gate is how the backtest becomes an expensive lesson.
