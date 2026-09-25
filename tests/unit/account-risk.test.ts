import { describe, expect, it } from 'vitest'
import { checkAccountRisk, type AccountRiskContext } from '../../src/risk/account-risk.js'
import { DEFAULT_RISK_PROFILE, loadRiskProfile } from '../../src/risk/risk-profile.js'

function ctx(overrides: Partial<AccountRiskContext> = {}): AccountRiskContext {
  return {
    openPositionsCount: 0,
    totalExposureUsd: 0,
    candidatePositionUsd: 10,
    dailyRealizedLossUsd: 0,
    drawdown7dPct: 0,
    totalDrawdownPct: 0,
    consecutiveLosses: 0,
    ...overrides,
  }
}

describe("DEFAULT_RISK_PROFILE matches the spec's $1,000 V1 profile exactly", () => {
  it('every field', () => {
    expect(DEFAULT_RISK_PROFILE).toEqual({
      accountLimitUsd: 1000,
      maxPositionPct: 2.5,
      maxPositionUsd: 25,
      maxTotalExposurePct: 10,
      maxTotalExposureUsd: 100,
      maxOpenPositions: 4,
      maxDailyLossPct: 3,
      maxDailyLossUsd: 30,
      max7dDrawdownPct: 7,
      maxTotalDrawdownPct: 12,
      maxConsecutiveLosses: 5,
    })
  })
})

describe('loadRiskProfile', () => {
  it('falls back to defaults when no env vars are set', () => {
    expect(loadRiskProfile({})).toEqual(DEFAULT_RISK_PROFILE)
  })

  it('overrides individual fields from env', () => {
    const profile = loadRiskProfile({
      MAX_OPEN_POSITIONS: '6',
      ACCOUNT_LIMIT_USD: '500',
    } as NodeJS.ProcessEnv)
    expect(profile.maxOpenPositions).toBe(6)
    expect(profile.accountLimitUsd).toBe(500)
    expect(profile.maxPositionUsd).toBe(DEFAULT_RISK_PROFILE.maxPositionUsd) // untouched fields keep their default
  })

  it('rejects a negative or non-numeric override', () => {
    expect(() => loadRiskProfile({ MAX_OPEN_POSITIONS: '-1' } as NodeJS.ProcessEnv)).toThrow()
    expect(() => loadRiskProfile({ MAX_OPEN_POSITIONS: 'abc' } as NodeJS.ProcessEnv)).toThrow()
  })
})

describe('checkAccountRisk — the $1,000 profile ceilings', () => {
  it('a clean, empty account passes', () => {
    expect(checkAccountRisk(ctx(), DEFAULT_RISK_PROFILE).ok).toBe(true)
  })

  it('per-position cap: $25 is the binding constraint (min of $25 flat and 2.5% of $1000=$25 — they coincide at the default profile)', () => {
    const v = checkAccountRisk(ctx({ candidatePositionUsd: 26 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_position_cap')
  })

  it('total exposure cap: adding this position would exceed $100', () => {
    const v = checkAccountRisk(ctx({ totalExposureUsd: 90, candidatePositionUsd: 15 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_exposure_cap')
  })

  it('open positions cap: already at 4 open positions refuses a 5th', () => {
    const v = checkAccountRisk(ctx({ openPositionsCount: 4 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_open_positions_cap')
  })

  it('daily loss limit: today already lost $30', () => {
    const v = checkAccountRisk(ctx({ dailyRealizedLossUsd: 30 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_daily_loss_limit')
  })

  it('7-day drawdown limit', () => {
    const v = checkAccountRisk(ctx({ drawdown7dPct: 7 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_7d_drawdown_limit')
  })

  it('total drawdown limit', () => {
    const v = checkAccountRisk(ctx({ totalDrawdownPct: 12 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_total_drawdown_limit')
  })

  it('consecutive losses limit', () => {
    const v = checkAccountRisk(ctx({ consecutiveLosses: 5 }), DEFAULT_RISK_PROFILE)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('account_consecutive_losses')
  })

  it('checks are evaluated in a fixed order — position cap surfaces before exposure cap when both would fail', () => {
    const v = checkAccountRisk(
      ctx({ candidatePositionUsd: 999, totalExposureUsd: 999 }),
      DEFAULT_RISK_PROFILE,
    )
    expect(v.reason).toBe('account_position_cap')
  })

  it('a custom (tighter) profile is respected independently of the defaults', () => {
    const tight = { ...DEFAULT_RISK_PROFILE, maxOpenPositions: 1 }
    expect(checkAccountRisk(ctx({ openPositionsCount: 1 }), tight).ok).toBe(false)
    expect(checkAccountRisk(ctx({ openPositionsCount: 1 }), DEFAULT_RISK_PROFILE).ok).toBe(true)
  })
})
