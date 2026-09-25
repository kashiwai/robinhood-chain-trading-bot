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

Nine named conditions: `rpc_unhealthy`, `database_error`, `sell_failure`, `daily_loss_exceeded`,
`drawdown_exceeded`, `consecutive_losses`, `price_oracle_disagreement`, `nonce_failure`,
`reconciliation_mismatch`. `buyPaused()` blocks new buys when any is tripped — there is
deliberately no `sellPaused()`; sells always go through, because refusing to sell during a risk
event is strictly worse than refusing to buy.

Currently only `rpc_unhealthy` is auto-wired to a real trigger (`src/main.ts`'s 15-second RPC
health poll). The other eight conditions are fully built and unit-tested, and `trip()`/`clear()`
are exposed for a future automatic trigger or the dashboard to call — documented here as a real
scope boundary, not silently claimed as fully automatic.

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

## Emergency exit (`src/exits/emergency-exit.ts`, pure/IO-free)

Seven named trigger conditions, all checked every call, all reported (not just the first match).
Not currently invoked from a scheduled loop in `main.ts` — the function exists and is fully
tested; wiring a periodic emergency-exit sweep is a documented next step, not a hidden gap.
