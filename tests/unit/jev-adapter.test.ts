import { describe, expect, it, vi } from 'vitest'
import { JevAdapter } from '../../src/decision/jev-adapter.js'
import type { FeatureVector } from '../../src/decision/feature-vector.js'
import * as llm from '../../src/framework/llm.js'

const fv: FeatureVector = {
  token_age_seconds: 60,
  liquidity_score: 80,
  price_impact_25: 0.01,
  price_impact_100: 0.02,
  contract_risk: 5,
  sellability_score: 90,
  deployer_score: 90,
  smart_wallet_count: 1,
  independent_wallet_count: 1,
  wallet_score_mean: 70,
  cluster_score: 0,
  buy_pressure: 100,
  sell_pressure: 20,
  volume_acceleration: 0.5,
  price_momentum: 0.1,
  holder_concentration: null,
}

describe('JevAdapter — fail-closed on any error', () => {
  it('a successful call returns the verdict and a real measured latency', async () => {
    vi.spyOn(llm, 'judgeFeatureVector').mockResolvedValue({
      decision: 'BUY',
      confidence: 0.8,
      reasonCodes: ['clean_contract'],
    })
    const adapter = new JevAdapter({ provider: 'anthropic', apiKey: 'x' })
    const result = await adapter.judge(fv)
    expect(result.verdict).toEqual({ decision: 'BUY', confidence: 0.8, reasonCodes: ['clean_contract'] })
    expect(result.error).toBeNull()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    vi.restoreAllMocks()
  })

  it('a thrown error (timeout, malformed JSON, HTTP failure) resolves verdict:null, never throws', async () => {
    vi.spyOn(llm, 'judgeFeatureVector').mockRejectedValue(new Error('provider timed out'))
    const adapter = new JevAdapter({ provider: 'anthropic', apiKey: 'x' })
    const result = await adapter.judge(fv)
    expect(result.verdict).toBeNull()
    expect(result.error).toMatch(/timed out/)
    vi.restoreAllMocks()
  })

  it('serializes the feature vector as the judged content, not a natural-language brief', async () => {
    const spy = vi
      .spyOn(llm, 'judgeFeatureVector')
      .mockResolvedValue({ decision: 'REJECT', confidence: 0.9, reasonCodes: [] })
    const adapter = new JevAdapter({ provider: 'anthropic', apiKey: 'x' })
    await adapter.judge(fv)
    const [, passedContent] = spy.mock.calls[0]!
    expect(JSON.parse(passedContent)).toEqual(fv)
    vi.restoreAllMocks()
  })
})
