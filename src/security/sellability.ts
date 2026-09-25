import type { Address } from 'viem'
import type { Market } from '../framework/market.js'

export interface SellabilityResult {
  token: Address
  /** Tokens received for `probeAmountIn` of the quote token — null if no buy route exists at all. */
  buyAmountOut: bigint | null
  /** Quote token received selling `buyAmountOut` straight back — null if no sell route exists (the classic honeypot signature). */
  sellAmountOut: bigint | null
  /** `sellAmountOut / probeAmountIn`, i.e. what fraction of the original spend a round trip returns. 1.0 = no loss. */
  roundTripRetention: number | null
  sellable: boolean
  reason: string
}

/**
 * Round-trip sellability: quote a buy, then quote selling exactly what that
 * buy would return, straight back to the same quote token. This is the same
 * mechanism `LaunchSniper` already proved out (its `evaluate()` filters 1-2)
 * — generalized here so Level 5's liquidity/hard-reject pipeline and any
 * other caller share one implementation instead of duplicating it.
 *
 * Both legs go through `Market.quoteBuy`/`quoteSell`, i.e. Uniswap V3's
 * QuoterV2 — a real `eth_call` simulation against live pool state, not a
 * price-math approximation. What this does NOT catch: a fee-on-transfer
 * token whose tax logic QuoterV2's swap-math simulation doesn't reflect in
 * `amountOut` (a known V3 quoter limitation for some FOT implementations).
 * Catching that exactly needs a real balance-delta simulation
 * (`eth_simulateV1`, confirmed reachable on this chain during Level 5's
 * development — see the Level 5 report) impersonating a real token holder;
 * deliberately left for a later pass rather than shipped half-verified.
 */
export async function checkSellability(
  market: Pick<Market, 'quoteBuy' | 'quoteSell'>,
  token: Address,
  quoteToken: Address,
  probeAmountIn: bigint,
): Promise<SellabilityResult> {
  const buyQuote = await market.quoteBuy(quoteToken, token, probeAmountIn)
  if (!buyQuote || buyQuote.amountOut <= 0n) {
    return {
      token,
      buyAmountOut: null,
      sellAmountOut: null,
      roundTripRetention: null,
      sellable: false,
      reason: 'no liquid buy route',
    }
  }

  const sellQuote = await market.quoteSell(token, quoteToken, buyQuote.amountOut)
  if (!sellQuote || sellQuote.amountOut <= 0n) {
    return {
      token,
      buyAmountOut: buyQuote.amountOut,
      sellAmountOut: null,
      roundTripRetention: null,
      sellable: false,
      reason: 'no sell route back — classic honeypot signature',
    }
  }

  const retention = Number(sellQuote.amountOut) / Number(probeAmountIn)
  return {
    token,
    buyAmountOut: buyQuote.amountOut,
    sellAmountOut: sellQuote.amountOut,
    roundTripRetention: retention,
    sellable: true,
    reason: `round trip retains ${(retention * 100).toFixed(1)}% of input`,
  }
}
