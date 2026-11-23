// BTC race bot: rare, confirmed trend trades on 1-minute cbBTC bars.
//
// Idea: 1-minute bars whipsaw. Every round trip costs ~26 bps, and the house
// EMA-cross bot loses $114.83 on the dev window by trading 76 times; a 1% trailing
// stop fires on 689 of 1,440 bars (the window's max pullback from its trailing
// peak is only 1.98%). So this bot trades rarely and only on a confirmed trend:
//   - enter (flat) when close > EMA(48), EMA(8) > EMA(21), and the trailing
//     120-bar return is above TREND_MIN (a real move, not noise);
//   - exit the whole position on a WIDE trailing stop (2.5% below the peak close
//     since entry) or a 3% hard stop — never on a fast EMA cross, which is noise
//     on 1-minute bars;
//   - after any exit, a cool-off (no re-entry for COOLDOWN bars) so a whipsaw
//     cannot re-buy into the same chop;
//   - a drawdown circuit breaker: if equity falls 5% below its peak, flatten
//     and cool off for 120 bars. This is the race-window insurance: one bad call
//     cannot breach the 25% guardrail.
// Sizing is all-in (100% of cash) on entry: with $1,000 and ~26 bps per round
// trip, partial positions only dilute the signal. Long only, one position.
//
// Determinism: float64 arithmetic on closes only, no randomness, no clock,
// no environment, no files. The same bars give the same orders, run after run.

import { runBars, type BarsState, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST = 8;
const SLOW = 21;
const TREND = 48;
const RET_LOOKBACK = 120;
const TREND_MIN = 0.015; // trailing 120-bar return must beat 1.5% to enter
const TRAIL = 0.025; // trailing stop: 2.5% below the peak close since entry
const HARD_STOP = 0.03; // hard stop: 3% below the entry close
const COOLDOWN = 120; // bars of no re-entry after an exit
const EXIT_ON_CROSS_DOWN = false; // EMA(8) < EMA(21) exit: too noisy on 1-min bars
const DD_BREAK = 0.05; // flatten + cool off when equity is 5% below its peak
const DD_COOLDOWN = 120;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

const closes: number[] = [];
const fast: Ema = { span: FAST, warm: [], value: null };
const slow: Ema = { span: SLOW, warm: [], value: null };
const trend: Ema = { span: TREND, warm: [], value: null };

let entryClose = 0; // close the entry was decided on
let peakSinceEntry = 0; // highest close seen while holding
let peakEquity = 0n; // highest equity seen (quote units)
let coolUntil = -1; // no entries while seq < coolUntil
let wasHolding = false;

await runBars({
  onBatch(state: BarsState, batch) {
    const bar: Bar | undefined = batch.bars[0];
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    stepEma(fast, close);
    stepEma(slow, close);
    stepEma(trend, close);
    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get('CBBTC');
    const holding = held !== undefined && held.qty > 0n;
    if (holding && !wasHolding) {
      // Position just filled: seed the trailing stop from the entry close.
      peakSinceEntry = Math.max(entryClose, close);
    }
    if (holding) {
      if (close > peakSinceEntry) peakSinceEntry = close;
    }
    wasHolding = holding;

    // Drawdown circuit breaker: flatten everything, long cool-off.
    if (holding && peakEquity > 0n && state.equity * 100n < peakEquity * 95n) {
      coolUntil = batch.seq + DD_COOLDOWN;
      const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }

    if (holding) {
      const trailHit = close < peakSinceEntry * (1 - TRAIL);
      const crossDown = EXIT_ON_CROSS_DOWN && fast.value !== null && slow.value !== null && fast.value < slow.value;
      const hardStop = entryClose > 0 && close < entryClose * (1 - HARD_STOP);
      if (trailHit || crossDown || hardStop) {
        coolUntil = batch.seq + COOLDOWN;
        const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: consider an entry.
    if (batch.seq < coolUntil) return [];
    // Strictly more than RET_LOOKBACK closes: at exactly RET_LOOKBACK the index
    // closes.length - 1 - RET_LOOKBACK is -1 (undefined), and a NaN comparison
    // would silently pass the trend check. (This bug fired the entry at bar 119
    // in v1/v2a/v2d/v2e testing; fixed 2026-11-23.)
    if (closes.length <= RET_LOOKBACK) return []; // need trend history + seeded EMAs
    if (fast.value === null || slow.value === null || trend.value === null) return [];
    if (close <= trend.value) return [];
    if (fast.value <= slow.value) return [];
    const ret60 = close / closes[closes.length - 1 - RET_LOOKBACK] - 1;
    if (ret60 <= TREND_MIN) return [];
    if (state.cash <= 0n) return [];
    entryClose = close;
    peakSinceEntry = close;
    const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
