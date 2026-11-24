# Pump.fun Paper Sprint — Early Momentum Rider

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ahmadcrypto/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ahmadcrypto/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot for pump.fun bonding curves, replayed on a 6-hour window and ranked by net PnL.

## Strategy

**Early Momentum Rider** (`main.ts`, Node 22, harness `agent-fun/replay/v2`):

- Watch every new curve from its `CreateEvent`.
- Buy early, on the first sign of real buying: at least 1 trade, price ≥ 2% above creation, ≥ 0.1 SOL of real reserves. One buy per coin, 0.05 SOL stake (capped by the 1%-of-real-reserve size cap, never below 0.01 SOL so every round trip counts toward the 20-coin guardrail).
- Exit tight: take profit +25%, stop loss −6%, a trailing exit once a coin ran +10% and gave back 10% from its peak, or a stale exit after 600 slots (~4 min) so the 5 open-position slots keep rotating onto fresh coins.
- Fully deterministic: every decision is a pure function of the delivered events (prices from virtual reserves, slots, trade counts). No clock, no environment, no randomness — the two grading runs produce byte-identical action logs.

## Local grading

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

Dev-window result (v4): net PnL −1.20 SOL, 710 round trips over 710 distinct mints, win rate 25.2%, max drawdown 12.0% (guardrail 50%), guardrails met, L1 regrade reproduced byte for byte. The dev window is a hard, fee-heavy market for momentum; the final 6-hour window is a fresh draw.

## Layout

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bot.ts` — the kit's bot shim, vendored byte-identical.
- `LICENSE` — MIT.
