import { afterEach, describe, expect, it } from 'vitest'
import { loadFleetConfig } from '../../src/framework/config.js'
import { Fleet } from '../../src/framework/fleet.js'
import { DEFAULT_RISK_PROFILE } from '../../src/risk/risk-profile.js'
import type { AccountRiskContext } from '../../src/risk/account-risk.js'

// Fleet's trade-result/account-risk-context aggregation (Level 7) has no
// public surface of its own — it's consumed internally via the
// `accountRisk.contextProvider` callback Agent gets. Reaching into the
// private methods directly (rather than driving a full Agent+Strategy+
// Market fake through a real tick) keeps this test focused on the
// aggregation MATH (daily rollover, 7-day drawdown, consecutive-loss
// tracking) without re-testing Agent's own already-covered wiring.
interface FleetInternals {
  recordTradeResultForTest(pnlUsd: number, now?: number): void
  accountRiskContextForTest(candidateUsd: number): AccountRiskContext
}

function testableFleet(): Fleet & FleetInternals {
  const config = loadFleetConfig({
    HOOD_TRADERS_DB: ':memory:',
    KILL_FILE: '/tmp/hood-traders-test-kill-does-not-exist',
  } as NodeJS.ProcessEnv)
  const fleet = new Fleet(config)
  const internals = fleet as unknown as {
    recordTradeResult: (pnlUsd: number, now?: number) => void
    accountRiskContext: (candidateUsd: number) => AccountRiskContext
  }
  return Object.assign(fleet, {
    recordTradeResultForTest: (pnlUsd: number, now?: number) => internals.recordTradeResult(pnlUsd, now),
    accountRiskContextForTest: (candidateUsd: number) => internals.accountRiskContext(candidateUsd),
  })
}

describe('Fleet — Level 7 account-wide risk aggregation', () => {
  const fleets: Fleet[] = []
  afterEach(() => {
    for (const f of fleets) f.close()
    fleets.length = 0
  })
  function make(): Fleet & FleetInternals {
    const f = testableFleet()
    fleets.push(f)
    return f
  }

  it('a fresh fleet has zero exposure, zero drawdown, zero consecutive losses', () => {
    const fleet = make()
    const ctx = fleet.accountRiskContextForTest(10)
    expect(ctx.dailyRealizedLossUsd).toBe(0)
    expect(ctx.drawdown7dPct).toBe(0)
    expect(ctx.totalDrawdownPct).toBe(0)
    expect(ctx.consecutiveLosses).toBe(0)
    expect(ctx.candidatePositionUsd).toBe(10)
  })

  it('a losing trade increases dailyRealizedLossUsd and drawdown; a winning trade after it resets consecutiveLosses', () => {
    const fleet = make()
    fleet.recordTradeResultForTest(-20)
    let ctx = fleet.accountRiskContextForTest(0)
    expect(ctx.dailyRealizedLossUsd).toBeCloseTo(20, 6)
    expect(ctx.consecutiveLosses).toBe(1)
    // drawdown = (peak(0) - cumulative(-20)) / accountLimitUsd(1000) * 100 = 2%
    expect(ctx.totalDrawdownPct).toBeCloseTo(2, 6)

    fleet.recordTradeResultForTest(50)
    ctx = fleet.accountRiskContextForTest(0)
    expect(ctx.consecutiveLosses).toBe(0) // reset by the win
    expect(ctx.dailyRealizedLossUsd).toBeCloseTo(0, 6) // net +30 today, not a loss
    expect(ctx.totalDrawdownPct).toBeCloseTo(0, 6) // new peak reached, no drawdown
  })

  it('consecutive losses accumulate across multiple losing trades in a row', () => {
    const fleet = make()
    fleet.recordTradeResultForTest(-5)
    fleet.recordTradeResultForTest(-5)
    fleet.recordTradeResultForTest(-5)
    expect(fleet.accountRiskContextForTest(0).consecutiveLosses).toBe(3)
  })

  it('daily loss rolls over at the UTC day boundary', () => {
    const fleet = make()
    const day1 = Date.UTC(2026, 0, 1, 12) // noon UTC Jan 1
    const day2 = Date.UTC(2026, 0, 2, 1) // 1am UTC Jan 2 — a new UTC day
    fleet.recordTradeResultForTest(-15, day1)
    expect(fleet.accountRiskContextForTest(0).dailyRealizedLossUsd).toBeCloseTo(15, 6)
    fleet.recordTradeResultForTest(-5, day2)
    expect(fleet.accountRiskContextForTest(0).dailyRealizedLossUsd).toBeCloseTo(5, 6) // day1's loss no longer counted
  })

  it('drawdown from the ALL-TIME peak persists even after the 7-day window would have pruned it', () => {
    const fleet = make()
    const t0 = Date.UTC(2026, 0, 1)
    const tenDaysLater = t0 + 10 * 24 * 60 * 60 * 1000
    fleet.recordTradeResultForTest(100, t0) // peak reached: cumulative = 100
    fleet.recordTradeResultForTest(-100, tenDaysLater) // cumulative back to 0, 10 days after the peak

    const ctx = fleet.accountRiskContextForTest(0)
    // all-time peak (100) is tracked independently of the 7-day window's pruning
    expect(ctx.totalDrawdownPct).toBeCloseTo((100 / DEFAULT_RISK_PROFILE.accountLimitUsd) * 100, 6)
    // the 7-day window itself no longer contains the t0 peak sample (pruned), so
    // its "peak" is just the most recent (only remaining) sample — no false drawdown signal from a decade-old high.
    expect(ctx.drawdown7dPct).toBeCloseTo(0, 6)
  })
})
