import { describe, expect, it } from 'vitest'
import { ruleVerdict, DEFAULT_RULE_THRESHOLDS } from '../../src/decision/rules.js'
import type { FeatureVector } from '../../src/decision/feature-vector.js'

function fv(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    token_age_seconds: 60,
    liquidity_score: 80,
    price_impact_25: 0.005,
    price_impact_100: 0.02,
    contract_risk: 5,
    sellability_score: 90,
    deployer_score: 90,
    smart_wallet_count: 0,
    independent_wallet_count: 0,
    wallet_score_mean: 0,
    cluster_score: 0,
    buy_pressure: 0,
    sell_pressure: 0,
    volume_acceleration: 0,
    price_momentum: 0,
    holder_concentration: null,
    ...overrides,
  }
}

describe('ruleVerdict', () => {
  it('a vector that comfortably clears every threshold, with strong smart-money/independence signals, decides BUY', () => {
    const v = ruleVerdict(
      fv({
        contract_risk: 2,
        sellability_score: 97,
        liquidity_score: 95,
        price_impact_100: 0.005,
        smart_wallet_count: 3,
        independent_wallet_count: 3,
      }),
    )
    expect(v.decision).toBe('BUY')
    expect(v.reasonCodes).toContain('clean_contract')
    expect(v.reasonCodes).toContain('smart_money_buying')
  })

  it('a clean vector with NO smart-money signal only reaches WATCH, never BUY', () => {
    const v = ruleVerdict(fv())
    expect(v.decision).toBe('WATCH')
  })

  it('high contract risk hard-rejects regardless of everything else', () => {
    const v = ruleVerdict(fv({ contract_risk: 90, smart_wallet_count: 5, independent_wallet_count: 5 }))
    expect(v.decision).toBe('REJECT')
    expect(v.reasonCodes).toContain('contract_risk')
  })

  it('low sellability hard-rejects', () => {
    const v = ruleVerdict(fv({ sellability_score: 10 }))
    expect(v.decision).toBe('REJECT')
    expect(v.reasonCodes).toContain('low_sellability')
  })

  it('shallow liquidity (either the score or the $100 impact check) hard-rejects', () => {
    expect(ruleVerdict(fv({ liquidity_score: 5 })).decision).toBe('REJECT')
    expect(ruleVerdict(fv({ price_impact_100: 0.5 })).decision).toBe('REJECT')
  })

  it('a high deployer concentration (low deployer_score) hard-rejects', () => {
    const v = ruleVerdict(fv({ deployer_score: 10 }))
    expect(v.decision).toBe('REJECT')
  })

  it('a token that fails on multiple fronts has HIGHER reject confidence than one that fails narrowly', () => {
    const narrow = ruleVerdict(fv({ contract_risk: DEFAULT_RULE_THRESHOLDS.maxContractRisk + 1 }))
    const wide = ruleVerdict(fv({ contract_risk: 100, sellability_score: 0, liquidity_score: 0 }))
    expect(wide.confidence).toBeGreaterThan(narrow.confidence)
  })

  it('cluster_coordinated is flagged when cluster_score is high', () => {
    const v = ruleVerdict(fv({ cluster_score: 80, smart_wallet_count: 2, independent_wallet_count: 2 }))
    expect(v.reasonCodes).toContain('cluster_coordinated')
  })

  it('buy_pressure / sell_pressure reason codes reflect the dominant side', () => {
    expect(ruleVerdict(fv({ buy_pressure: 200, sell_pressure: 50 })).reasonCodes).toContain('buy_pressure')
    expect(ruleVerdict(fv({ buy_pressure: 50, sell_pressure: 200 })).reasonCodes).toContain('sell_pressure')
  })

  it('custom thresholds are respected', () => {
    const strict = ruleVerdict(fv({ contract_risk: 30 }), { ...DEFAULT_RULE_THRESHOLDS, maxContractRisk: 20 })
    expect(strict.decision).toBe('REJECT')
    const lenient = ruleVerdict(fv({ contract_risk: 30 }), {
      ...DEFAULT_RULE_THRESHOLDS,
      maxContractRisk: 50,
    })
    expect(lenient.decision).not.toBe('REJECT')
  })

  it('confidence is always clamped to [0, 1]', () => {
    for (const risk of [0, 50, 100, 1000]) {
      const v = ruleVerdict(fv({ contract_risk: risk }))
      expect(v.confidence).toBeGreaterThanOrEqual(0)
      expect(v.confidence).toBeLessThanOrEqual(1)
    }
  })
})
