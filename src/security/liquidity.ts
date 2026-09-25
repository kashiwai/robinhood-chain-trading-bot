import { formatUnits, parseUnits, type Address } from 'viem'
import type { Market } from '../framework/market.js'

/** USD sell sizes the spec calls out by name. */
export const LIQUIDITY_PROBE_TIERS_USD = [10, 25, 50, 100, 250, 500, 1000] as const

export interface LiquidityTierResult {
  usdTier: number
  /** Fraction of `usdTier`'s value lost to price impact selling that size right now. 0 = none, 1 = total loss. null = no route at all at this size. */
  impact: number | null
}

export interface LiquidityReport {
  token: Address
  tiers: LiquidityTierResult[]
  /** 0 (illiquid) - 100 (deep) — see `scoreLiquidity`'s doc comment. */
  liquidityScore: number
}

/**
 * Sell-side price impact at each of the spec's USD tiers: "if I currently
 * hold $N of this token, what fraction of that value do I lose selling it
 * right now?" Each tier converts $N to a token amount at the CURRENT spot
 * price, then quotes an actual sell of that amount — a real QuoterV2
 * `eth_call` against live pool liquidity for every tier, not a single quote
 * scaled by math (V3 liquidity is NOT linear across ticks, so scaling one
 * quote would misrepresent deeper tiers).
 */
export async function computeExecutableLiquidity(
  market: Pick<Market, 'quoteSell'>,
  token: Address,
  quoteToken: Address,
  spotPriceUsd: number,
  quoteTokenUsdPrice: number,
  tokenDecimals = 18,
  quoteDecimals = 18,
  tiersUsd: readonly number[] = LIQUIDITY_PROBE_TIERS_USD,
): Promise<LiquidityReport> {
  const tiers: LiquidityTierResult[] = []
  for (const usdTier of tiersUsd) {
    if (spotPriceUsd <= 0) {
      tiers.push({ usdTier, impact: null })
      continue
    }
    const tokenAmountFloat = usdTier / spotPriceUsd
    const amountIn = parseUnits(tokenAmountFloat.toFixed(Math.min(tokenDecimals, 18)), tokenDecimals)
    const quote = await market.quoteSell(token, quoteToken, amountIn)
    if (!quote || quote.amountOut <= 0n) {
      tiers.push({ usdTier, impact: null })
      continue
    }
    const proceedsUsd = Number(formatUnits(quote.amountOut, quoteDecimals)) * quoteTokenUsdPrice
    const impact = Math.max(0, 1 - proceedsUsd / usdTier)
    tiers.push({ usdTier, impact })
  }
  return { token, tiers, liquidityScore: scoreLiquidity(tiers) }
}

/**
 * 0-100 liquidity score. An initial, documented heuristic (like
 * wallet-score.ts and cluster-signal.ts): the spec's own example thresholds
 * — sell $25 impact < 1%, sell $100 impact < 3%, sell $500 impact < 10% —
 * are used directly as the three checkpoints a linear interpolation is
 * anchored to, rather than inventing different numbers.
 */
export function scoreLiquidity(tiers: readonly LiquidityTierResult[]): number {
  const at = (usd: number): number | null => tiers.find((t) => t.usdTier === usd)?.impact ?? null
  const t25 = at(25)
  const t100 = at(100)
  const t500 = at(500)

  if (t25 === null && t100 === null && t500 === null) return 0 // no route resolvable at any checkpoint tier

  let score = 100
  if (t25 !== null)
    score -= clamp01(t25 / 0.01) * 30 // up to 30 pts lost if $25 impact reaches or exceeds 1%
  else score -= 30
  if (t100 !== null)
    score -= clamp01(t100 / 0.03) * 40 // up to 40 pts lost if $100 impact reaches or exceeds 3%
  else score -= 40
  if (t500 !== null)
    score -= clamp01(t500 / 0.1) * 30 // up to 30 pts lost if $500 impact reaches or exceeds 10%
  else score -= 30

  return Math.max(0, Math.min(100, score))
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
