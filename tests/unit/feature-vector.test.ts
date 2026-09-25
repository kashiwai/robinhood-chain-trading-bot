import { describe, expect, it } from 'vitest'
import {
  buildFeatureVector,
  type FeatureVectorInputs,
  type RecentTrade,
} from '../../src/decision/feature-vector.js'
import type { ContractRiskReport } from '../../src/security/contract-risk.js'
import type { SellabilityResult } from '../../src/security/sellability.js'
import type { LiquidityReport } from '../../src/security/liquidity.js'
import type { Address } from 'viem'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address

function cleanRisk(): ContractRiskReport {
  return {
    address: TOKEN,
    hasCode: true,
    isProxy: false,
    implementationAddress: null,
    ownerAddress: null,
    ownerRenounced: true,
    hasMintSelector: false,
    mintCallableByOutsider: null,
    isPaused: false,
    hasPauseSelector: false,
    hasBlacklistSelector: false,
    hasMaxTxWalletSelectors: false,
    riskFlags: [],
    riskScore: 5,
  }
}

function sellability(overrides: Partial<SellabilityResult> = {}): SellabilityResult {
  return {
    token: TOKEN,
    buyAmountOut: 1000n,
    sellAmountOut: 950n,
    roundTripRetention: 0.95,
    sellable: true,
    reason: 'ok',
    ...overrides,
  }
}

function liquidity(overrides: Partial<LiquidityReport> = {}): LiquidityReport {
  return {
    token: TOKEN,
    tiers: [
      { usdTier: 25, impact: 0.01 },
      { usdTier: 100, impact: 0.03 },
    ],
    liquidityScore: 80,
    ...overrides,
  }
}

function baseInputs(overrides: Partial<FeatureVectorInputs> = {}): FeatureVectorInputs {
  return {
    tokenAgeSeconds: 120,
    contractRisk: cleanRisk(),
    sellability: sellability(),
    liquidity: liquidity(),
    deployerPct: 0.05,
    buyers: [],
    independentEntityCount: 0,
    clusterScore: 0,
    recentTrades: [],
    now: 1_000_000,
    ...overrides,
  }
}

describe('buildFeatureVector', () => {
  it('maps every straightforward field directly', () => {
    const fv = buildFeatureVector(baseInputs())
    expect(fv.token_age_seconds).toBe(120)
    expect(fv.contract_risk).toBe(5)
    expect(fv.liquidity_score).toBe(80)
    expect(fv.price_impact_25).toBeCloseTo(0.01, 6)
    expect(fv.price_impact_100).toBeCloseTo(0.03, 6)
    expect(fv.sellability_score).toBeCloseTo(95, 6)
    expect(fv.deployer_score).toBeCloseTo(95, 6) // (1 - 0.05) * 100
  })

  it('holder_concentration is always null — genuinely not computable', () => {
    expect(buildFeatureVector(baseInputs()).holder_concentration).toBeNull()
  })

  it('an unsellable token scores 0 sellability regardless of a stale roundTripRetention field', () => {
    const fv = buildFeatureVector(
      baseInputs({ sellability: sellability({ sellable: false, roundTripRetention: null }) }),
    )
    expect(fv.sellability_score).toBe(0)
  })

  it('a null deployerPct is a neutral (50) deployer_score, not a penalty or a bonus', () => {
    const fv = buildFeatureVector(baseInputs({ deployerPct: null }))
    expect(fv.deployer_score).toBe(50)
  })

  it('missing liquidity tiers default to full (worst-case) impact, not zero', () => {
    const fv = buildFeatureVector(baseInputs({ liquidity: liquidity({ tiers: [] }) }))
    expect(fv.price_impact_25).toBe(1)
    expect(fv.price_impact_100).toBe(1)
  })

  it('smart_wallet_count only counts buyers at/above the threshold', () => {
    const fv = buildFeatureVector(
      baseInputs({ buyers: [{ walletScore: 80 }, { walletScore: 40 }, { walletScore: 60 }] }),
    )
    expect(fv.smart_wallet_count).toBe(2) // 80 and 60 clear the default 60 threshold
    expect(fv.wallet_score_mean).toBeCloseTo(60, 6) // mean over ALL buyers, not just smart ones
  })

  it('a custom smartWalletScoreThreshold is respected', () => {
    const fv = buildFeatureVector(
      baseInputs({ buyers: [{ walletScore: 70 }], smartWalletScoreThreshold: 90 }),
    )
    expect(fv.smart_wallet_count).toBe(0)
  })

  it('buy_pressure and sell_pressure sum USD notional within the window only', () => {
    const trades: RecentTrade[] = [
      { side: 'buy', amountUsd: 100, mcapUsd: null, ts: 999_800 }, // inside the 5-min window ending at now=1_000_000
      { side: 'sell', amountUsd: 30, mcapUsd: null, ts: 999_900 },
      { side: 'buy', amountUsd: 500, mcapUsd: null, ts: 100 }, // ancient — outside the window
    ]
    const fv = buildFeatureVector(baseInputs({ recentTrades: trades, now: 1_000_000 }))
    expect(fv.buy_pressure).toBeCloseTo(100, 6)
    expect(fv.sell_pressure).toBeCloseTo(30, 6)
  })

  it('volume_acceleration is 0 (flat) when there is no prior-window data to compare against', () => {
    const trades: RecentTrade[] = [{ side: 'buy', amountUsd: 100, mcapUsd: null, ts: 999_900 }]
    const fv = buildFeatureVector(baseInputs({ recentTrades: trades, now: 1_000_000 }))
    expect(fv.volume_acceleration).toBe(0)
  })

  it('volume_acceleration reflects a real doubling between the prior and current window', () => {
    const windowMs = 300_000
    const now = 1_000_000
    const trades: RecentTrade[] = [
      { side: 'buy', amountUsd: 100, mcapUsd: null, ts: now - windowMs - 100 }, // prior window: $100
      { side: 'buy', amountUsd: 200, mcapUsd: null, ts: now - 100 }, // current window: $200
    ]
    const fv = buildFeatureVector(baseInputs({ recentTrades: trades, now, windowMs }))
    expect(fv.volume_acceleration).toBeCloseTo(1.0, 6) // 100% increase
  })

  it('price_momentum reflects mcap change across priced samples in the window', () => {
    const trades: RecentTrade[] = [
      { side: 'buy', amountUsd: 10, mcapUsd: 100_000, ts: 999_100 },
      { side: 'buy', amountUsd: 10, mcapUsd: 150_000, ts: 999_900 },
    ]
    const fv = buildFeatureVector(baseInputs({ recentTrades: trades, now: 1_000_000 }))
    expect(fv.price_momentum).toBeCloseTo(0.5, 6) // +50%
  })

  it('price_momentum is 0 with fewer than 2 priced samples', () => {
    const trades: RecentTrade[] = [{ side: 'buy', amountUsd: 10, mcapUsd: 100_000, ts: 999_900 }]
    const fv = buildFeatureVector(baseInputs({ recentTrades: trades, now: 1_000_000 }))
    expect(fv.price_momentum).toBe(0)
  })
})
