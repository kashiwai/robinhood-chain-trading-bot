# Risk Management

## The $1,000 V1 account profile (`src/risk/risk-profile.ts`)

`DEFAULT_RISK_PROFILE` — every number below is asserted field-for-field in
`tests/unit/risk.test.ts` / `tests/unit/fleet-risk.test.ts`, not just documented:

| Field | Value |
|---|---|
| `accountLimitUsd` | $1,000 |
| `maxPositionPct` / `maxPositionUsd` | 2.5% / $25 |
| `maxTotalExposurePct` / `maxTotalExposureUsd` | 10% / $100 |
| `maxOpenPositions` | 4 |
| `maxDailyLossPct` / `maxDailyLossUsd` | 3% / $30 |
| `max7dDrawdownPct` | 7% |
| `maxTotalDrawdownPct` | 12% |
| `maxConsecutiveLosses` | 5 |

Overridable per-field via named env vars — see `loadRiskProfile()`.

## Two independent gates, both fail-closed

1. **Per-order `RiskEngine.check()`** (`src/framework/risk.ts`) — kill switch, cooldown, slippage
   bound, position/daily-spend caps. Runs for every single intent, buy or sell.
2. **Account-wide `checkAccountRisk()`** (`src/risk/account-risk.ts`) — fleet-wide exposure, open
   positions, daily loss, 7-day and total drawdown, consecutive losses. Buys only — sells are
   always exempt, on the same principle as the circuit breaker below (never trap capital in a
   losing position because a risk cap tripped).

Both run **before** execution, for every mode. Neither is a strategy's own responsibility to
check — `Agent.processIntent()` calls them unconditionally.

## The circuit breaker (`src/risk/circuit-breaker.ts`)

The spec's nine named conditions — `rpc_unhealthy`, `database_error`, `sell_failure`,
`daily_loss_exceeded`, `drawdown_exceeded`, `consecutive_losses`, `price_oracle_disagreement`,
`nonce_failure`, `reconciliation_mismatch` — plus a Level 10.1 tenth, `manual_pause` (an operator's
Telegram `/pause` command — see `docs/OPERATIONS.md`). `buyPaused()` blocks new buys when any is
tripped — there is deliberately no `sellPaused()`; sells always go through, because refusing to
sell during a risk event is strictly worse than refusing to buy.

Auto-wired to real triggers: `rpc_unhealthy` (`src/main.ts`'s 15-second RPC health poll) and
`manual_pause` (Telegram `/pause`). The other eight original conditions are fully built and
unit-tested, and `trip()`/`clear()` are exposed for a future automatic trigger or the dashboard to
call — documented here as a real scope boundary, not silently claimed as fully automatic. Every
trip fires a Telegram alert (`CIRCUIT_BREAKER`, or a more specific type for
`daily_loss_exceeded`/`drawdown_exceeded`/`rpc_unhealthy`/`reconciliation_mismatch`/
`database_error` — see `src/main.ts`'s `circuitBreaker.onTrip()` wiring) when Telegram is
configured.

## Drawdown accounting (`src/framework/fleet.ts`)

`Fleet` tracks `cumulativeRealizedPnlUsd`, `consecutiveLosses`, a UTC-day-rollover
`dailyRealizedPnlUsd`, `equityPeakAllTime`, and a pruned 7-day `equityHistory7d` — all updated from
real sell fills via `reportTradeResult()`. Drawdown percentages are measured against
`riskProfile.accountLimitUsd` ($1,000), not the fluctuating peak, so a small early peak can't make
later drawdown percentages look artificially large.

## Exits (`src/exits/exit-engine.ts`, wired into `launch-sniper.ts`)

Stateless per call, driven by `pos.meta.exitState` persisted across ticks:

- **-12%**: full stop-loss exit, from any state.
- **+20% (TP1)**: sell 25% of the *original* position size.
- **+40% (TP2)**: sell another 25% of the original (computed as a fraction of what remains, since
  TP1 already reduced the position).
- Remaining 50% trails 15 percentage points from its post-TP2 peak.

## Emergency exit (`src/exits/emergency-exit.ts`) — Level 10.1: now wired

Seven named trigger conditions (`liquidity_collapse`, `deployer_dump`, `critical_contract_change`,
`sellability_degradation`, `cluster_smart_money_exit`, `extreme_sell_pressure`,
`rpc_quote_anomaly`), all checked every call, all reported (not just the first match) — pure,
IO-free logic over a caller-supplied `EmergencyExitInput`.

**Wired into `Agent.monitorPositions()`**, called at the start of every tick — right after
`markPositions()`, before the strategy gets a turn — for every open position, in every mode
(Shadow/Paper/Probe/Live). Priority is enforced by execution order, not a shared priority-queue
data structure: a full emergency exit closes (or refuses-and-leaves-untouched) the position before
`decide()` snapshots positions for the strategy's own hard-stop/take-profit/JEV logic that same
tick, so it can never race an emergency exit.

Two signals are computed by the Agent itself, for free, every tick:
- `currentlySellable` — from the SAME sell-quote `markPositions()` already fetches; debounced to
  require 3 consecutive failed quotes (not 1) before treating it as a real sellability loss, so a
  transient RPC blip doesn't trigger a panic sell.
- `quoteAnomalyDetected` — a >50% single-tick mark-to-mark price crash.

The rest (liquidity collapse, contract-risk jump, retention drop, deployer dump, smart-money exit,
sell-pressure spike) come from the optional `emergencyMonitor` hook
(`src/exits/emergency-monitor.ts`'s `EmergencyMonitorHooks`), wired in `main.ts` via
`createRealEmergencyMonitor()` (`src/exits/emergency-context.ts`) — real Level 5 security scans
(`scanContractRisk`, `computeExecutableLiquidity`, `checkSellability`) and Level 3/4 wallet
intelligence (`WalletStore.recentTransfers`, `computeWalletScore`), throttled to a configurable
rescan interval (default 60s) since they're real RPC calls. Missing or unavailable signals default
to values that never trip a check — fail-open on this EXTRA layer only, never weakening any
existing protection.

**Idempotency**: an in-memory in-flight lock (`emergencyExitInFlight`) plus a deterministic
idempotency key (`emergency-exit:<token>:<position openedAt>`) passed through to the Level 6
`Executor`/`OrderStore` — a repeated trigger for the same still-open position (e.g. the first sell
attempt failed and the condition persists into the next tick) reuses the SAME order-store key, so
Level 6's existing "same key returns the existing row" guarantee prevents a second broadcast.
Verified directly: a test asserts every retry attempt for one position uses an identical
idempotency key. A failed emergency sell leaves the position exactly as-is — `applyFill()` (which
reduces/closes a position) is only ever reached on the success path.

Every trigger is journaled twice — once when detected (`phase: 'triggered'`, with position id,
token, trigger reasons, the full signal snapshot, current mark, liquidity, sellability, timestamp)
and once when resolved (`phase: 'resolved'`, adding the order id, tx hash, result, and Level 6
reconciliation state) — and sends a Telegram `EMERGENCY_EXIT` alert when configured.

## Probe failure classification (`src/execution/probe-failure.ts`) — Level 10.1

A failed $2 probe (see `docs/LIVE_TRADING.md`) no longer blanket-blacklists. `classifyProbeFailure()`
sorts every failure into one of three buckets by pattern-matching the failure reason:

- **`PERMANENT_TOKEN_FAILURE`** (honeypot, on-chain revert, blacklist/tax/owner restriction, or any
  unrecognized failure — the safe default) → permanently blacklisted, same as before Level 10.1.
- **`TEMPORARY_INFRA_FAILURE`** (RPC timeout, HTTP 429, disconnect, receipt-wait timeout) →
  **quarantined** for a configurable cooldown (default 30 min — `ProbeConfig.quarantineCooldownMs`),
  never blacklisted.
- **`MARKET_FAILURE`** (no route, insufficient liquidity, price impact) → also quarantined, not
  blacklisted.

`ProbeStore.isQuarantined(token, now, cooldownMs)` and `ProbeGate`'s new `'quarantined'` action
(distinct from `'blacklisted'`) implement the retry: once the cooldown elapses, the token becomes
eligible for a fresh probe attempt again. `retryCount` tracks how many infra/market attempts a
token has accumulated (never incremented by a permanent failure, since there's no more retrying
after that). All three classifications, and every probe attempt, are recorded in `ProbeStore` and
visible via `allRecords()` — feeding both the Launch Gate's `PROBE_PASS` evidence and Telegram's
`PROBE_START`/`PROBE_PASS`/`PROBE_FAIL` alerts.
