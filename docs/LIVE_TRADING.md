# Live Trading — the path from zero to real money

This document describes the actual sequence this codebase enforces before it will sign a single
live transaction. It is written to be read alongside the code it describes — every claim below
names the file that implements it.

## The four phases (spec sections 10-B through 10-E)

| Phase | What runs | What it proves | Script |
|---|---|---|---|
| Shadow | Paper mode, real market data, no funds | The discovery/decision pipeline stays up | `scripts/start-shadow.sh` |
| Paper | Same process as Shadow | The strategies actually close trades | `scripts/start-paper.sh` |
| Probe | Live mode, tiny caps | Real tokens are actually sellable, at real tax | `scripts/start-probe.sh` |
| Live | Live mode, full $1,000 caps | — | `scripts/start-live.sh` |

Shadow and Paper are the same running process — a paper-mode fleet accumulates the shadow-run
uptime clock (`src/gates/shadow-run.ts`) and closed paper trades (`src/framework/journal.ts`)
simultaneously, both read from the same on-disk state. There is nothing to separately "start" for
Paper once Shadow is running.

## The Launch Gate (`src/gates/launch-gate.ts`)

`evaluateLaunchGate()` is all-or-nothing — every one of 8 flags must be true, or `ready: false`
with a human-readable blocker per failing flag:

- `LEVEL_1_9_PASS` / `REPLAY_PASS` — the real unit and replay suites passed, recently
  (`npm run check-launch-gate`, see below)
- `SHADOW_PASS` — ≥72 continuous hours, ≥95% of health checks healthy
- `PAPER_PASS` — ≥200 closed (buy+sell matched) paper trades
- `PROBE_PASS` — ≥20 real probe cycles, ALL reconciled, zero mismatches
- `SECURITY_PASS` — the secret scan came back clean
- `BACKUP_PASS` — a backup ran within the last 24 hours
- `RECOVERY_PASS` — restart recovery is wired (static fact — it always is, see below)

This is enforced **inside `src/main.ts`**, not just advisory: when `config.mode === 'live'`, the
process calls `collectLaunchGateEvidence()` (real journal/probe/order/shadow-run data — see
`src/gates/collect-evidence.ts`) and `evaluateLaunchGate()`. If `ready` is not `true`, it prints
every blocker and calls `process.exit(1)` **before constructing the wallet-signing `Executor`**.
No env var or script flag bypasses this — the check runs unconditionally on every live-mode boot.

Run `npm run check-launch-gate` (`scripts/check-launch-gate.mjs`) to actually execute the unit
suite, replay suite, and secret scan, and write their result to `data/launch-gate-status.json` —
the file `main.ts` reads for the `LEVEL_1_9_PASS`/`REPLAY_PASS`/`SECURITY_PASS` flags. A missing or
stale status file reads as `false`, not `true` — fail closed.

## The probe gate (`src/execution/probe-gate.ts`)

Independent of, and layered underneath, the Launch Gate: **every token's first-ever live buy is
always a real $2 round trip first**, never the strategy's full-size order. This is wired directly
into `Agent.processIntent()` (`src/framework/agent.ts`) — a token with no existing position, in
live mode, with a `probeGate` configured, is intercepted before execution:

- Already probe-passed → the full-size buy proceeds normally.
- Never probed → the $2 probe runs *instead of* the full-size buy this tick; the strategy's
  original intent is refused this tick (`reason: probe_ran_this_tick`) and retried next tick,
  by which point the token is either passed (trades normally) or blacklisted.
- Blacklisted (this probe or a past one) → refused outright, permanently
  (`src/execution/probe-store.ts` has no `unblacklist()` method — by design).

This means "probe mode" and "live mode" are the same code path; `scripts/start-probe.sh` just
defaults the per-agent/day USD caps low while that trust is being built.

## Explicit consent — three conditions, not two

`src/framework/config.ts`'s `loadFleetConfig()` resolves `mode: 'live'` only when **all three** of
`HOOD_TRADERS_LIVE=1`, a valid `ROBINHOOD_CHAIN_PRIVATE_KEY`, and `LIVE_ACKNOWLEDGED=YES` (exact
string) are set. Any one missing silently falls back to paper mode — never an error, never a
partial-live state.

## Restart recovery

`recoverPendingOrders()` (`src/execution/executor.ts`) runs immediately on every live-mode boot,
before the probe gate or Launch Gate check, reconciling `OrderStore`'s pending rows against real
chain state. It never auto-resubmits (double-spend risk) — it only reconciles, marks
no-txHash orders `FAILED`, and leaves genuinely-unconfirmed ones pending for a human to look at.

## What this codebase cannot do for you

The 72 shadow hours, 200 paper trades, and 20 probe cycles all require real elapsed wall-clock
time (and, for probes, a real funded wallet). No script or code path in this repository simulates
or fast-forwards them — doing so would defeat the entire point of the gate. Run
`scripts/start-shadow.sh`, let it run, then `scripts/start-probe.sh` once Shadow/Paper pass, then
`scripts/start-live.sh` once the gate reports `ready: true`.
