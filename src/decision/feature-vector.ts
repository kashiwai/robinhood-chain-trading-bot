import type { ContractRiskReport } from '../security/contract-risk.js'
import type { SellabilityResult } from '../security/sellability.js'
import type { LiquidityReport } from '../security/liquidity.js'

/**
 * The spec's unified feature schema — every field a real number (or `null`
 * for the one field this codebase genuinely cannot compute yet, see
 * `holder_concentration` below) so every decision mode (rules, JEV, or a
 * blend — see decision/ensemble.ts) scores off the exact same inputs.
 */
export interface FeatureVector {
  token_age_seconds: number
  liquidity_score: number
  price_impact_25: number
  price_impact_100: number
  contract_risk: number
  sellability_score: number
  deployer_score: number
  smart_wallet_count: number
  independent_wallet_count: number
  wallet_score_mean: number
  cluster_score: number
  buy_pressure: number
  sell_pressure: number
  volume_acceleration: number
  price_momentum: number
  /**
   * Genuinely not computable from anything this codebase tracks today: a
   * real holder-concentration figure (e.g. top-10-holder share of supply)
   * needs a full holder index built from every Transfer this token has ever
   * emitted, not just the trades wallet-tracker.ts happens to have observed
   * post-launch. Returned as `null` rather than backed by a proxy metric
   * dressed up as the real thing — see decision/feature-vector.test.ts.
   */
  holder_concentration: number | null
}

export interface RecentTrade {
  side: 'buy' | 'sell'
  amountUsd: number
  mcapUsd: number | null
  ts: number
}

export interface SmartWalletInput {
  walletScore: number
}

export interface FeatureVectorInputs {
  tokenAgeSeconds: number
  contractRisk: ContractRiskReport
  sellability: SellabilityResult
  liquidity: LiquidityReport
  /** Fraction (0-1) of supply the deployer holds, when known. */
  deployerPct: number | null
  /** Buyers seen so far, each carrying their Level 3 wallet score (0-100). */
  buyers: SmartWalletInput[]
  /** Threshold a buyer's wallet score must clear to count as "smart". @defaultValue 60 */
  smartWalletScoreThreshold?: number
  /** Level 4's cluster signal for this token's buyer set. */
  independentEntityCount: number
  clusterScore: number
  /** Level 3's trade ledger for this token, oldest first. */
  recentTrades: RecentTrade[]
  /** Momentum/pressure window. @defaultValue 300000 (5 min) */
  windowMs?: number
  now: number
}

const DEFAULT_SMART_WALLET_THRESHOLD = 60
const DEFAULT_WINDOW_MS = 5 * 60_000

export function buildFeatureVector(inputs: FeatureVectorInputs): FeatureVector {
  const smartThreshold = inputs.smartWalletScoreThreshold ?? DEFAULT_SMART_WALLET_THRESHOLD
  const windowMs = inputs.windowMs ?? DEFAULT_WINDOW_MS

  const smartWallets = inputs.buyers.filter((b) => b.walletScore >= smartThreshold)
  const walletScoreMean =
    inputs.buyers.length > 0 ? inputs.buyers.reduce((s, b) => s + b.walletScore, 0) / inputs.buyers.length : 0

  const windowStart = inputs.now - windowMs
  const inWindow = inputs.recentTrades.filter((t) => t.ts >= windowStart)
  const priorWindow = inputs.recentTrades.filter((t) => t.ts >= windowStart - windowMs && t.ts < windowStart)

  const buyPressure = sumUsd(inWindow, 'buy')
  const sellPressure = sumUsd(inWindow, 'sell')
  const recentVolume = buyPressure + sellPressure
  const priorVolume = sumUsd(priorWindow, 'buy') + sumUsd(priorWindow, 'sell')
  // No prior-window data (a token younger than 2x the window) reads as flat
  // (0), not infinite/undefined — there's nothing to accelerate FROM yet.
  const volumeAcceleration = priorVolume > 0 ? (recentVolume - priorVolume) / priorVolume : 0

  const priceMomentum = computePriceMomentum(inWindow)

  const impact25 = inputs.liquidity.tiers.find((t) => t.usdTier === 25)?.impact ?? 1
  const impact100 = inputs.liquidity.tiers.find((t) => t.usdTier === 100)?.impact ?? 1

  const sellabilityScore = inputs.sellability.sellable
    ? Math.max(0, Math.min(1, inputs.sellability.roundTripRetention ?? 0)) * 100
    : 0

  const deployerScore =
    inputs.deployerPct === null ? 50 : Math.max(0, Math.min(100, (1 - inputs.deployerPct) * 100))

  return {
    token_age_seconds: Math.max(0, inputs.tokenAgeSeconds),
    liquidity_score: inputs.liquidity.liquidityScore,
    price_impact_25: impact25,
    price_impact_100: impact100,
    contract_risk: inputs.contractRisk.riskScore,
    sellability_score: sellabilityScore,
    deployer_score: deployerScore,
    smart_wallet_count: smartWallets.length,
    independent_wallet_count: inputs.independentEntityCount,
    wallet_score_mean: walletScoreMean,
    cluster_score: inputs.clusterScore,
    buy_pressure: buyPressure,
    sell_pressure: sellPressure,
    volume_acceleration: volumeAcceleration,
    price_momentum: priceMomentum,
    holder_concentration: null,
  }
}

function sumUsd(trades: RecentTrade[], side: 'buy' | 'sell'): number {
  return trades.filter((t) => t.side === side).reduce((s, t) => s + t.amountUsd, 0)
}

/** % change in market cap from the window's earliest to latest priced sample. 0 if fewer than 2 priced samples. */
function computePriceMomentum(trades: RecentTrade[]): number {
  const priced = trades.filter((t) => t.mcapUsd !== null) as (RecentTrade & { mcapUsd: number })[]
  if (priced.length < 2) return 0
  const first = priced[0]!.mcapUsd
  const last = priced[priced.length - 1]!.mcapUsd
  if (first <= 0) return 0
  return (last - first) / first
}
