# Live Trading — the path from zero to real money

This document describes the actual sequence this codebase enforces before it will sign a single
live transaction. It is written to be read alongside the code it describes — every claim below
names the file that implements it.

## The four phases (spec sections 10-B through 10-E)

| Phase | Mode | What it proves | Script | Data dir |
|---|---|---|---|---|
| Shadow | paper | The discovery/decision pipeline stays up ≥72h at ≥95% health | `scripts/start-shadow.sh` | `data/shadow/` |
| Paper | paper | The strategies actually close ≥200 trades | `scripts/start-paper.sh` | `data/paper/` |
| Probe | live, tiny caps | Real tokens are actually sellable, at real tax (≥20 cycles) | `scripts/start-probe.sh` | `data/probe/` |
| Live | live, full $1,000 caps | — | `scripts/start-live.sh` | `data/live/` |

**Level 10.1: each phase is a genuinely independent process with its own SQLite stores** —
`HOOD_RUN_PHASE` (set automatically by each `start-*.sh` script) scopes every DB file and
`shadow-run.json` under `data/<phase>/` (see `phaseScopedPath()` in `src/framework/config.ts`).
Shadow and Paper can run **at the same time**, on different ports, without sharing a DB, journal,
or state cursor — verified directly in this session by running both scripts concurrently against
the same base `HOOD_TRADERS_DB` path with zero collisions. This replaces an earlier (Level 10)
design where Shadow and Paper were the same process; that assumption no longer holds.

## The Launch Gate (`src/gates/launch-gate.ts`)

`evaluateLaunchGate()` is all-or-nothing — every one of 9 flags must be true, or `ready: false`
with a human-readable blocker per failing flag:

- `LEVEL_1_9_PASS` / `REPLAY_PASS` — the real unit and replay suites passed, recently
  (`npm run check-launch-gate`, see below)
- `SHADOW_PASS` — ≥72 continuous hours, ≥95% of health checks healthy (read from `data/shadow/`)
- `PAPER_PASS` — ≥200 closed (buy+sell matched) paper trades (read from `data/paper/`)
- `PROBE_PASS` — ≥20 real probe cycles, ALL reconciled, zero mismatches (read from `data/probe/`)
- `SECURITY_PASS` — the secret scan came back clean
- `BACKUP_PASS` — a backup ran within the last 24 hours
- `RECOVERY_PASS` — restart recovery is wired (static fact — it always is, see below)
- `BUILD_FINGERPRINT_PASS` — Level 10.1: the accumulated evidence was recorded under the SAME
  build attempting to go live (see below)

This is enforced **inside `src/main.ts`**, only when `config.runPhase === 'live'` — the `probe`
phase is itself one of the gate's prerequisites, so it is never gated against itself. When
checking, the live-phase process opens **read-only instances** of `ShadowRunTracker`/`Journal`/
`ProbeStore`/`OrderStore` pointed at the sibling `data/shadow/`, `data/paper/`, `data/probe/`
directories — it never reads its own (empty, freshly-started) `data/live/` for this. If `ready` is
not `true`, it prints every blocker and calls `process.exit(1)` **before constructing the
wallet-signing `Executor`**. No env var or script flag bypasses this.

Run `npm run check-launch-gate` (`scripts/check-launch-gate.mjs`) to actually execute the unit
suite, replay suite, and secret scan, and write their result to `data/launch-gate-status.json` —
the file `main.ts` reads for the `LEVEL_1_9_PASS`/`REPLAY_PASS`/`SECURITY_PASS` flags. A missing or
stale status file reads as `false`, not `true` — fail closed.

## The build fingerprint (`src/gates/build-fingerprint.ts`) — Level 10.1

Every accumulated evidence bundle is pinned to a **build fingerprint** the moment a shadow run
first starts (`ShadowRunTracker.recordedFingerprint()`), computed from:

- `gitCommitSha` — `git rev-parse HEAD` (or `GIT_COMMIT_SHA` env, for bundled deployments with no
  `.git`)
- `configHash` — a hash of the trading-affecting config (risk profile, fleet limits, stock-token
  eligibility)
- `strategyVersion` — a hash of the actual constructed strategy parameters
- `databaseSchemaVersion` — `DATABASE_SCHEMA_VERSION` in `src/framework/journal.ts`, bumped
  manually whenever any store's schema changes
- `chainId`, `rpcProviderConfigurationHash`

**Strict by default**: `evaluateFingerprintMatch()` rejects on ANY mismatch, including a bare
`gitCommitSha` change — a docs-only commit invalidates prior evidence unless the operator
explicitly names it in `LAUNCH_GATE_ALLOWED_PRIOR_SHAS` (comma-separated prior SHAs they've
reviewed and vouch for). That allowance only excuses the SHA field — a mismatched `configHash`
still blocks regardless, so a mislabeled "docs-only" commit that actually changed trading logic is
still caught. Verified live in this session: a shadow run recorded with
`FLEET_MAX_DAILY_SPEND_USDG=100`, then a live-phase attempt with `FLEET_MAX_DAILY_SPEND_USDG=999`,
was correctly rejected with `mismatched fields: configHash`.

## The probe gate (`src/execution/probe-gate.ts`)

Independent of, and layered underneath, the Launch Gate: **every token's first-ever live buy is
always a real $2 round trip first**, never the strategy's full-size order. Wired directly into
`Agent.processIntent()` — a token with no existing position, in live mode, with a `probeGate`
configured, is intercepted before execution:

- Already probe-passed → the full-size buy proceeds normally.
- Never probed → the $2 probe runs *instead of* the full-size buy this tick; refused
  (`probe_ran_this_tick`) and retried next tick.
- **Level 10.1: a failed probe is classified** (`src/execution/probe-failure.ts`) into
  `PERMANENT_TOKEN_FAILURE` (honeypot, on-chain revert, blacklist/tax restriction — permanently
  blacklisted, no `unblacklist()` method exists anywhere), `TEMPORARY_INFRA_FAILURE` (RPC
  timeout/429/disconnect), or `MARKET_FAILURE` (no route/insufficient liquidity) — the latter two
  **quarantine** the token for a configurable cooldown (default 30 min) instead of blacklisting it
  forever, since an RPC hiccup proves nothing about the token.

`scripts/start-probe.sh` defaults the per-agent/day USD caps low while that trust is being built —
it is not a separate code path from full live trading.

## Emergency exit (`src/exits/emergency-exit.ts`, `src/exits/emergency-monitor.ts`) — Level 10.1

Wired into `Agent.monitorPositions()`, called every tick, for every open position, in every mode
(Shadow/Paper/Probe/Live), **before** the strategy gets a turn — so a full emergency exit closes
the position before a strategy's own hard-stop/take-profit logic could act on it that same tick.
Never waits on JEV/LLM: `checkEmergencyExit()` is pure synchronous logic over already-fetched
signals. Two signals (sellability, price-anomaly) are computed by the Agent itself at zero extra
cost; the rest (liquidity collapse, contract-risk jump, deployer dump, smart-money exit, sell
pressure) come from `createRealEmergencyMonitor()` (`src/exits/emergency-context.ts`), which wires
real Level 5 security scans and Level 3/4 wallet intelligence — throttled to avoid rescanning every
tick. A deterministic idempotency key (`emergency-exit:<token>:<openedAt>`) prevents a double
broadcast if the same condition persists across ticks. See `docs/RISK_MANAGEMENT.md` for detail.

## Explicit consent — three conditions, not two

`loadFleetConfig()` resolves `mode: 'live'` only when **all three** of `HOOD_TRADERS_LIVE=1`, a
valid `ROBINHOOD_CHAIN_PRIVATE_KEY`, and `LIVE_ACKNOWLEDGED=YES` (exact string) are set. Any one
missing silently falls back to paper mode. `HOOD_RUN_PHASE` (probe/live) must additionally agree
with the resolved mode — `loadFleetConfig` throws rather than silently running the wrong phase in
the wrong mode.

## Restart recovery

`recoverPendingOrders()` runs immediately on every live-mode boot, before the probe gate or Launch
Gate check, reconciling `OrderStore`'s pending rows against real chain state. It never
auto-resubmits — it only reconciles, marks no-txHash orders `FAILED`, and leaves
genuinely-unconfirmed ones pending for a human to look at.

## What this codebase cannot do for you

The 72 shadow hours, 200 paper trades, and 20 probe cycles all require real elapsed wall-clock
time (and, for probes, a real funded wallet). No script or code path in this repository simulates
or fast-forwards them. Run `scripts/start-shadow.sh` and `scripts/start-paper.sh` (simultaneously
or separately), then `scripts/start-probe.sh` once they pass, then `scripts/start-live.sh` once the
gate reports `ready: true`. See `docs/OPERATIONS.md` for the RC-freeze workflow this is meant to
run under.
