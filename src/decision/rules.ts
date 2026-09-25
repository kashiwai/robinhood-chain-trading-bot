import type { FeatureVector } from './feature-vector.js'
import type { JevDecision } from '../framework/llm.js'

export interface RuleThresholds {
  maxContractRisk: number
  minSellabilityScore: number
  minLiquidityScore: number
  maxPriceImpact100: number
  minDeployerScore: number
}

export const DEFAULT_RULE_THRESHOLDS: RuleThresholds = {
  maxContractRisk: 40,
  minSellabilityScore: 60,
  minLiquidityScore: 40,
  maxPriceImpact100: 0.05,
  minDeployerScore: 60,
}

export interface RuleVerdict {
  decision: JevDecision
  confidence: number
  reasonCodes: string[]
}

/**
 * RULE mode: the deterministic decision mode Level 8's comparison uses as
 * the baseline every other mode (JEV, RULE+JEV, ...) is measured against —
 * fixed thresholds against the same {@link FeatureVector} every mode reads.
 * Confidence is not a model's self-reported number here; it's how far past
 * (or short of) each threshold the vector sits, averaged — a token that
 * clears every bar comfortably scores a higher confidence than one that
 * barely squeaks through.
 */
export function ruleVerdict(
  fv: FeatureVector,
  thresholds: RuleThresholds = DEFAULT_RULE_THRESHOLDS,
): RuleVerdict {
  const reasons: string[] = []
  let hardFail = false

  if (fv.contract_risk > thresholds.maxContractRisk) {
    reasons.push('contract_risk')
    hardFail = true
  } else {
    reasons.push('clean_contract')
  }

  if (fv.sellability_score < thresholds.minSellabilityScore) {
    reasons.push('low_sellability')
    hardFail = true
  } else {
    reasons.push('high_sellability')
  }

  if (fv.liquidity_score < thresholds.minLiquidityScore) {
    reasons.push('shallow_liquidity')
    hardFail = true
  } else {
    reasons.push('deep_liquidity')
  }

  if (fv.price_impact_100 > thresholds.maxPriceImpact100) {
    reasons.push('shallow_liquidity')
    hardFail = true
  }

  if (fv.deployer_score < thresholds.minDeployerScore) {
    hardFail = true
  }

  if (fv.smart_wallet_count > 0) reasons.push('smart_money_buying')
  if (fv.independent_wallet_count >= 3) reasons.push('independent_buyers')
  if (fv.cluster_score >= 70) reasons.push('cluster_coordinated')
  if (fv.buy_pressure > fv.sell_pressure * 1.5) reasons.push('buy_pressure')
  else if (fv.sell_pressure > fv.buy_pressure * 1.5) reasons.push('sell_pressure')

  if (hardFail) {
    return { decision: 'REJECT', confidence: rejectConfidence(fv, thresholds), reasonCodes: dedupe(reasons) }
  }

  // Every hard gate cleared — WATCH vs BUY is a softer confidence call on how
  // comfortably it cleared them, deliberately independent of wallet-
  // intelligence signals (smart money / cluster diversity): RULE mode is the
  // Level 5 safety/liquidity baseline the mode ladder builds on top of —
  // JEV_SMART_WALLET / JEV_SMART_WALLET_CLUSTER are where that evidence gets
  // required (see decision/ensemble.ts), not here.
  const margin = averageMargin(fv, thresholds)
  const decision: JevDecision = margin > 0.3 ? 'BUY' : 'WATCH'
  return { decision, confidence: Math.max(0, Math.min(1, 0.5 + margin)), reasonCodes: dedupe(reasons) }
}

function averageMargin(fv: FeatureVector, t: RuleThresholds): number {
  const margins = [
    normMargin(t.maxContractRisk - fv.contract_risk, 100),
    normMargin(fv.sellability_score - t.minSellabilityScore, 100),
    normMargin(fv.liquidity_score - t.minLiquidityScore, 100),
    normMargin(t.maxPriceImpact100 - fv.price_impact_100, 1),
  ]
  return margins.reduce((s, m) => s + m, 0) / margins.length
}

function rejectConfidence(fv: FeatureVector, t: RuleThresholds): number {
  // How decisively it failed — a token failing by a wide margin is a more
  // confident REJECT than one that missed a single threshold narrowly.
  const deficits = [
    normMargin(fv.contract_risk - t.maxContractRisk, 100),
    normMargin(t.minSellabilityScore - fv.sellability_score, 100),
    normMargin(t.minLiquidityScore - fv.liquidity_score, 100),
  ].filter((d) => d > 0)
  if (deficits.length === 0) return 0.6 // failed on deployer_score alone — a real but singular red flag
  return Math.max(0, Math.min(1, 0.5 + deficits.reduce((s, d) => s + d, 0) / deficits.length))
}

function normMargin(diff: number, scale: number): number {
  return Math.max(-1, Math.min(1, diff / scale))
}

function dedupe(reasons: string[]): string[] {
  return [...new Set(reasons)]
}
