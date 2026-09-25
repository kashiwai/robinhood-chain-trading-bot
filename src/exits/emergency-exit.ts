export type EmergencyReason =
  | 'liquidity_collapse'
  | 'deployer_dump'
  | 'critical_contract_change'
  | 'sellability_degradation'
  | 'cluster_smart_money_exit'
  | 'extreme_sell_pressure'
  | 'rpc_quote_anomaly'

export interface EmergencyExitInput {
  currentLiquidityScore: number
  entryLiquidityScore: number
  currentContractRiskScore: number
  entryContractRiskScore: number
  currentlySellable: boolean
  currentRoundTripRetention: number | null
  entryRoundTripRetention: number | null
  /** Caller-detected: the deployer's held balance dropped since entry (a fresh sell/transfer out, not just an unrealized-concentration number). */
  deployerBalanceDropped: boolean
  /** Caller-detected: wallets that were net buyers of this token at entry are now net sellers (Level 3/4 data). */
  smartMoneyNowSelling: boolean
  buyPressureUsd: number
  sellPressureUsd: number
  /** Caller-detected: the last quote attempt failed outright, or returned a price wildly inconsistent with the recent trend. */
  quoteAnomalyDetected: boolean
}

export interface EmergencyExitVerdict {
  shouldExit: boolean
  reasons: EmergencyReason[]
}

const LIQUIDITY_COLLAPSE_RATIO = 0.5 // current score below half of entry's
const CRITICAL_CONTRACT_RISK_JUMP = 30 // points
const CRITICAL_CONTRACT_RISK_FLOOR = 80 // points, regardless of entry
const SELLABILITY_RETENTION_DROP = 0.3 // 30 percentage points
const SELL_PRESSURE_RATIO = 3 // sell pressure must be 3x buy pressure...
const SELL_PRESSURE_MIN_USD = 20 // ...and at least this much, to avoid tripping on two tiny trades

/**
 * The spec's seven named emergency conditions — checked and acted on BEFORE
 * (and independently of) the normal TP/SL ladder or any JEV/decision-engine
 * call: "AIよりHard Exit優先". Every field here is a pre-computed signal the
 * caller supplies (this function does no IO itself, matching
 * decision/feature-vector.ts's pure-function/IO-orchestrator split) so it
 * stays trivially testable and so a caller can source signals from whatever
 * is cheapest/freshest at exit-check time rather than this function
 * dictating how they're fetched.
 *
 * Returns every condition that fired, not just the first — an emergency
 * exit's urgency doesn't depend on which reason is listed first, and a
 * position hit by two simultaneous red flags is still just one full exit.
 */
export function checkEmergencyExit(input: EmergencyExitInput): EmergencyExitVerdict {
  const reasons: EmergencyReason[] = []

  if (
    input.entryLiquidityScore > 0 &&
    input.currentLiquidityScore < input.entryLiquidityScore * LIQUIDITY_COLLAPSE_RATIO
  ) {
    reasons.push('liquidity_collapse')
  }

  if (input.deployerBalanceDropped) {
    reasons.push('deployer_dump')
  }

  if (
    input.currentContractRiskScore - input.entryContractRiskScore >= CRITICAL_CONTRACT_RISK_JUMP ||
    input.currentContractRiskScore >= CRITICAL_CONTRACT_RISK_FLOOR
  ) {
    reasons.push('critical_contract_change')
  }

  const retentionDropped =
    input.currentRoundTripRetention !== null &&
    input.entryRoundTripRetention !== null &&
    input.entryRoundTripRetention - input.currentRoundTripRetention >= SELLABILITY_RETENTION_DROP
  if (!input.currentlySellable || retentionDropped) {
    reasons.push('sellability_degradation')
  }

  if (input.smartMoneyNowSelling) {
    reasons.push('cluster_smart_money_exit')
  }

  if (
    input.sellPressureUsd >= SELL_PRESSURE_MIN_USD &&
    input.sellPressureUsd >= input.buyPressureUsd * SELL_PRESSURE_RATIO
  ) {
    reasons.push('extreme_sell_pressure')
  }

  if (input.quoteAnomalyDetected) {
    reasons.push('rpc_quote_anomaly')
  }

  return { shouldExit: reasons.length > 0, reasons }
}
