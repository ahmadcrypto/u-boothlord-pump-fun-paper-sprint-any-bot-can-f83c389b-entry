// Pump.fun Paper Sprint — "Early Momentum Rider" v4 (final).
//
// Own strategy, written from scratch for agent-fun/replay/v2:
//   - Watch every new curve from its CreateEvent.
//   - Buy EARLY, on the first sign of real buying: at least 1 trade,
//     price >= 2% above its creation price, and >= 0.1 SOL of real
//     reserves. One buy per coin, 0.05 SOL stake (capped by the
//     1%-of-real-reserve size cap, never below 0.01 SOL so every round
//     trip counts toward the 20-coin guardrail).
//   - Exit every position with a tight plan, tuned on the dev window
//     with a faithful local replay (v1 -2.82 SOL, v2 -1.43 SOL, v3
//     -2.42 SOL on the official grade-local; the replay sweep behind
//     this version lands near -0.9 SOL at the same trade count):
//     take profit at +25% vs entry, stop loss at -6% vs entry, a
//     trailing exit once a coin ran +10% and then gave back 10% from
//     its peak, or a stale exit after 600 slots (~4 min) so the 5
//     open-position slots keep rotating onto fresh coins. Pump.fun
//     curves dump within minutes; tight exits are what keep losers
//     small. Letting winners run past +25% (v3) did not pay — the
//     dev window's runners give the gains back before any trailing
//     stop can bank them.
//   - Goal: cover 20+ distinct mints (dev: ~700) while keeping
//     drawdown small (dev: ~10-15%, guardrail 50%).
//
// Fully deterministic: every decision is a pure function of the events
// the harness delivered (prices from virtual reserves, slots, trade
// counts). No clock, no environment, no Math.random — the two grading
// runs produce byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const STAKE_LAMPORTS = SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = SOL / 100n; // 0.01 SOL — round-trip guardrail floor
const MIN_TRADES = 1;
const MOMENTUM_BPS = 200; // +2% vs creation price
const MIN_REAL_RESERVE_LAMPORTS = SOL / 10n; // 0.1 SOL of real reserves
const TAKE_PROFIT_BPS = 2_500; // +25% vs entry
const STOP_LOSS_BPS = 600; // -6% vs entry: cut losers fast
const TRAIL_ARM_BPS = 1_000; // trailing exit arms once +10% above entry
const TRAIL_GIVEBACK_BPS = 1_000; // ...then sells after a 10% fall from the peak
const MAX_HOLD_SLOTS = 600; // stale exit, ~4 min of slots
const MAX_SLIPPAGE_BPS = 5_000;

interface Tracked {
  mint: string;
  createdSlot: number;
  createPrice: number; // lamports of SOL per token unit (virtual quote / virtual token)
  decided: boolean; // bought, skipped for good, or dropped
  entryPrice: number; // set once bought
  entrySlot: number; // set once bought
  peakPrice: number; // highest price seen since entry
}

const tracked = new Map<string, Tracked>();

/** Current price of a curve from its virtual reserves (SOL lamports per token). */
function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // Register new curves from this batch's CreateEvents.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent' && !tracked.has(e.mint)) {
        tracked.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          createPrice: curvePrice(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          decided: false,
          entryPrice: 0,
          entrySlot: 0,
          peakPrice: 0,
        });
      }
    }

    // --- Exits first: TP / SL / trailing / stale, sell the whole position. ---
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const t = tracked.get(mint);
      const curve = state.curves.get(mint);
      if (!t || !curve || curve.complete || t.entryPrice <= 0) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > t.peakPrice) t.peakPrice = price;
      const up = price >= t.entryPrice * (1 + TAKE_PROFIT_BPS / 10_000);
      const down = price <= t.entryPrice * (1 - STOP_LOSS_BPS / 10_000);
      const trailing =
        t.peakPrice >= t.entryPrice * (1 + TRAIL_ARM_BPS / 10_000) &&
        price <= t.peakPrice * (1 - TRAIL_GIVEBACK_BPS / 10_000);
      const stale = state.slot - t.entrySlot >= MAX_HOLD_SLOTS;
      if (up || down || trailing || stale) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    // --- Entries: fresh coins showing the first real buying, in batch event order. ---
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      const t = tracked.get(e.mint);
      if (!t || t.decided) continue;
      const curve = state.curves.get(e.mint);
      if (!curve || curve.complete) {
        t.decided = true;
        continue;
      }
      // Drop candidates that never showed momentum within the hold window.
      if (state.slot - t.createdSlot > MAX_HOLD_SLOTS) {
        t.decided = true;
        continue;
      }
      if (curve.trades < MIN_TRADES) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || price < t.createPrice * (1 + MOMENTUM_BPS / 10_000)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue; // too small yet; wait for the curve to grow
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) {
        t.decided = true; // cannot afford it; skip for good
        continue;
      }
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      t.decided = true;
      t.entryPrice = price;
      t.entrySlot = state.slot;
      t.peakPrice = price;
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
