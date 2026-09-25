import type { ContractRiskReport } from './contract-risk.js'
import type { SellabilityResult } from './sellability.js'
import type { LiquidityReport } from './liquidity.js'

export interface HardRejectInput {
  contractRisk: ContractRiskReport
  sellability: SellabilityResult
  liquidity: LiquidityReport
}

export interface HardRejectOptions {
  /** Round-trip retention below this fraction is "extreme sell tax". @defaultValue 0.5 (i.e. losing more than half) */
  extremeSellTaxThreshold: number
  /** liquidityScore below this is a reject. @defaultValue 20 */
  minLiquidityScore: number
  /**
   * `enforce` actually rejects (the live/probe/approval default). `shadow`
   * evaluates and records every reason but never sets `rejected` — the
   * spec's "研究用Shadow modeでは記録する" carve-out, for running the same
   * checks against real launches without acting on them yet.
   */
  mode: 'enforce' | 'shadow'
}

export const DEFAULT_HARD_REJECT_OPTIONS: HardRejectOptions = {
  extremeSellTaxThreshold: 0.5,
  minLiquidityScore: 20,
  mode: 'enforce',
}

export interface HardRejectVerdict {
  rejected: boolean
  reasons: string[]
}

/**
 * The spec's six named hard-reject conditions, combined:
 *   sell simulation failure / extreme sell tax / blacklist active /
 *   unbounded owner mint / liquidity below threshold / critical proxy risk
 *
 * Two of these lean on signals this repo can only approximate honestly —
 * documented at the point each is evaluated below, not silently treated as
 * exact.
 */
export function evaluateHardReject(
  input: HardRejectInput,
  opts: Partial<HardRejectOptions> = {},
): HardRejectVerdict {
  const o = { ...DEFAULT_HARD_REJECT_OPTIONS, ...opts }
  const reasons: string[] = []

  if (!input.sellability.sellable) {
    reasons.push(`sell simulation failure: ${input.sellability.reason}`)
  } else if (
    input.sellability.roundTripRetention !== null &&
    input.sellability.roundTripRetention < 1 - o.extremeSellTaxThreshold
  ) {
    reasons.push(
      `extreme sell tax: round trip retains only ${(input.sellability.roundTripRetention * 100).toFixed(1)}%`,
    )
  }

  // Blacklist: selector presence only (see contract-risk.ts's doc comment on
  // why selector presence is never treated as conclusive on its own) — no
  // behavioral probe exists for "am I currently blacklisted" without a
  // concrete address to check, so this is deliberately the weaker of the six
  // conditions, not verified the way mint/pause are.
  if (input.contractRisk.hasBlacklistSelector) {
    reasons.push('blacklist-capable contract (selector present — unconfirmed by behavior)')
  }

  // "Unbounded owner mint": the strongest, behaviorally-confirmed form is
  // mintCallableByOutsider === true (anyone can mint, no owner check at
  // all). Short of that, an active (non-renounced) owner plus a real mint
  // selector is treated as the same condition — this repo cannot confirm
  // from bytecode alone whether that mint has a supply cap, so "owner can
  // mint at all" is read as unbounded rather than assumed safe.
  if (input.contractRisk.mintCallableByOutsider === true) {
    reasons.push('unbounded mint: callable by ANY address')
  } else if (
    input.contractRisk.hasMintSelector &&
    !input.contractRisk.ownerRenounced &&
    input.contractRisk.ownerAddress !== null
  ) {
    reasons.push('unbounded owner mint: active owner retains mint capability')
  }

  if (input.liquidity.liquidityScore < o.minLiquidityScore) {
    reasons.push(
      `liquidity below threshold: score ${input.liquidity.liquidityScore.toFixed(0)} < ${o.minLiquidityScore}`,
    )
  }

  if (
    input.contractRisk.isProxy &&
    input.contractRisk.ownerAddress !== null &&
    !input.contractRisk.ownerRenounced
  ) {
    reasons.push('critical proxy risk: upgradeable with an active admin')
  }

  return { rejected: o.mode === 'enforce' && reasons.length > 0, reasons }
}
