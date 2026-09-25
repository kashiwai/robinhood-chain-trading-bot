import { decodeEventLog, type Address, type Log } from 'viem'
import { erc20Abi } from 'hoodchain'

export interface ReconciledFill {
  actualAmountOut: bigint | null
  actualPrice: number | null // quote-token units per whole input token (or vice versa — caller interprets per side)
  actualSlippageBps: number | null
}

/**
 * The actual fill, read from what really moved on-chain — the receipt's own
 * Transfer logs — rather than trusted from the pre-trade quote. "Quoteを
 * 約定と見なさない" (the spec's Level 6 opening line): `quotedAmountOut` is
 * what we expected; this is what we got. Sums every Transfer of
 * `outputToken` landing in `account` within the receipt (a swap can emit
 * more than one, e.g. a fee split) rather than trusting a single log or the
 * quote figure.
 */
export function reconcileFill(
  logs: readonly Log[],
  outputToken: Address,
  account: Address,
  quotedAmountOut: bigint,
  amountIn: bigint,
): ReconciledFill {
  let received = 0n
  let sawAny = false
  for (const log of logs) {
    if (log.address.toLowerCase() !== outputToken.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
        eventName: 'Transfer',
      })
      if (decoded.args.to.toLowerCase() !== account.toLowerCase()) continue
      received += decoded.args.value
      sawAny = true
    } catch {
      // not a Transfer log (or a log for a different event on the same address) — skip
    }
  }

  if (!sawAny) return { actualAmountOut: null, actualPrice: null, actualSlippageBps: null }

  const actualPrice = amountIn > 0n ? Number(received) / Number(amountIn) : null
  const actualSlippageBps =
    quotedAmountOut > 0n ? Number(((quotedAmountOut - received) * 10_000n) / quotedAmountOut) : null

  return { actualAmountOut: received, actualPrice, actualSlippageBps }
}
