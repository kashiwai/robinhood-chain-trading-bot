import { describe, expect, it, vi } from 'vitest'
import { evaluateEnsemble, ALL_DECISION_MODES } from '../../src/decision/ensemble.js'
import { JevAdapter } from '../../src/decision/jev-adapter.js'
import type { FeatureVector } from '../../src/decision/feature-vector.js'
import * as llm from '../../src/framework/llm.js'

function fv(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    token_age_seconds: 60,
    liquidity_score: 90,
    price_impact_25: 0.005,
    price_impact_100: 0.01,
    contract_risk: 2,
    sellability_score: 95,
    deployer_score: 95,
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

function mockJev(decision: 'BUY' | 'REJECT' | 'WATCH', confidence = 0.8) {
  vi.spyOn(llm, 'judgeFeatureVector').mockResolvedValue({ decision, confidence, reasonCodes: [] })
  return new JevAdapter({ provider: 'anthropic', apiKey: 'x' })
}

describe('evaluateEnsemble', () => {
  it('evaluates ALL FIVE modes on every call, regardless of which one is live — the shadow-recording requirement', async () => {
    const adapter = mockJev('BUY')
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 3, independent_wallet_count: 3 }), {
      liveMode: 'RULE',
      jevAdapter: adapter,
    })
    expect(result.results.map((r) => r.mode).sort()).toEqual([...ALL_DECISION_MODES].sort())
    vi.restoreAllMocks()
  })

  it('the same feature vector run through all 5 modes is exactly the "same replay dataset, compare strategies" case the spec asks for', async () => {
    const adapter = mockJev('BUY')
    const input = fv({ smart_wallet_count: 3, independent_wallet_count: 3 })
    const a = await evaluateEnsemble(input, { liveMode: 'RULE', jevAdapter: adapter })
    const b = await evaluateEnsemble(input, { liveMode: 'JEV_SMART_WALLET_CLUSTER', jevAdapter: adapter })
    // Only `liveMode`/`liveResult` differ — the full `results` array (every mode's shadow verdict) is identical.
    expect(a.results).toEqual(b.results)
    vi.restoreAllMocks()
  })

  it('RULE_JEV requires BOTH to say BUY — one REJECT sinks it even if the other says BUY', async () => {
    const adapter = mockJev('REJECT')
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 3, independent_wallet_count: 3 }), {
      liveMode: 'RULE_JEV',
      jevAdapter: adapter,
    })
    const ruleJev = result.results.find((r) => r.mode === 'RULE_JEV')!
    expect(ruleJev.decision).toBe('REJECT')
    vi.restoreAllMocks()
  })

  it('JEV_SMART_WALLET downgrades an otherwise-BUY to WATCH when there is zero smart-wallet evidence — never MORE bullish than RULE_JEV', async () => {
    const adapter = mockJev('BUY')
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 0, independent_wallet_count: 0 }), {
      liveMode: 'JEV_SMART_WALLET',
      jevAdapter: adapter,
    })
    const ruleJev = result.results.find((r) => r.mode === 'RULE_JEV')!
    const smartWallet = result.results.find((r) => r.mode === 'JEV_SMART_WALLET')!
    expect(ruleJev.decision).toBe('BUY')
    expect(smartWallet.decision).toBe('WATCH')
    expect(smartWallet.reasonCodes).toContain('no_smart_money')
    vi.restoreAllMocks()
  })

  it('JEV_SMART_WALLET_CLUSTER further downgrades without 2+ independent entities, even with smart wallets present', async () => {
    const adapter = mockJev('BUY')
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 3, independent_wallet_count: 1 }), {
      liveMode: 'JEV_SMART_WALLET_CLUSTER',
      jevAdapter: adapter,
    })
    const smartWallet = result.results.find((r) => r.mode === 'JEV_SMART_WALLET')!
    const cluster = result.results.find((r) => r.mode === 'JEV_SMART_WALLET_CLUSTER')!
    expect(smartWallet.decision).toBe('BUY') // 3 smart wallets clears that bar
    expect(cluster.decision).toBe('WATCH') // but only 1 independent entity behind them
    vi.restoreAllMocks()
  })

  it('FAIL-CLOSED: a JEV-dependent live mode with no adapter configured refuses, does not fall back silently', async () => {
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 3, independent_wallet_count: 3 }), {
      liveMode: 'JEV_SMART_WALLET_CLUSTER',
      jevAdapter: null,
    })
    expect(result.liveResult.decision).toBe('REJECT')
    expect(result.liveResult.reasonCodes).toContain('jev_unavailable_fail_closed')
  })

  it('FAIL-CLOSED: a JEV call that throws also refuses the live mode by default', async () => {
    vi.spyOn(llm, 'judgeFeatureVector').mockRejectedValue(new Error('timeout'))
    const adapter = new JevAdapter({ provider: 'anthropic', apiKey: 'x' })
    const result = await evaluateEnsemble(fv(), { liveMode: 'JEV', jevAdapter: adapter })
    expect(result.liveResult.decision).toBe('REJECT')
    expect(result.liveResult.reasonCodes).toContain('jev_unavailable_fail_closed')
    expect(result.jevError).toMatch(/timeout/)
    vi.restoreAllMocks()
  })

  it('the explicit rule-only fallback opt-in falls back to the RULE verdict INSTEAD of refusing — but ONLY when set', async () => {
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 3, independent_wallet_count: 3 }), {
      liveMode: 'JEV',
      jevAdapter: null,
      explicitRuleOnlyFallback: true,
    })
    const rule = result.results.find((r) => r.mode === 'RULE')!
    expect(result.liveResult.decision).toBe(rule.decision)
    expect(result.liveResult.reasonCodes).toContain('jev_unavailable_rule_fallback')
  })

  it('a pure RULE live mode is completely unaffected by JEV being unavailable — it never depended on it', async () => {
    const result = await evaluateEnsemble(fv({ smart_wallet_count: 3, independent_wallet_count: 3 }), {
      liveMode: 'RULE',
      jevAdapter: null,
    })
    expect(result.liveResult.decision).not.toBe('REJECT')
    expect(result.liveResult.reasonCodes).not.toContain('jev_unavailable_fail_closed')
  })

  it('latency is measured for the feature/decision stage and the JEV call independently', async () => {
    const adapter = mockJev('WATCH')
    const result = await evaluateEnsemble(fv(), { liveMode: 'RULE', jevAdapter: adapter })
    expect(result.latency.featureMs).toBeGreaterThanOrEqual(0)
    expect(result.latency.jevMs).toBeGreaterThanOrEqual(0)
    expect(result.latency.totalMs).toBeGreaterThanOrEqual(result.latency.featureMs)
    vi.restoreAllMocks()
  })

  it('jevMs is null when no adapter is configured at all (never attempted, not a zero-latency call)', async () => {
    const result = await evaluateEnsemble(fv(), { liveMode: 'RULE', jevAdapter: null })
    expect(result.latency.jevMs).toBeNull()
  })
})
