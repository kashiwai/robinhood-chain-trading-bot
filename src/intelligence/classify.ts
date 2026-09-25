import type { Address } from 'viem'

export type TransferClassification = 'buy' | 'sell' | 'transfer'

export interface ClassifiableTransfer {
  from: Address
  to: Address
}

/**
 * Classifies a single ERC-20 Transfer as `buy` (came from a known DEX/
 * launchpad contract — the wallet acquired the token by trading), `sell`
 * (went to one — the wallet disposed of it by trading), or `transfer`
 * (neither side is DEX infrastructure — a plain wallet-to-wallet move,
 * airdrop, or CEX deposit/withdrawal; not a trade, and must NOT feed PnL or
 * trade-count stats).
 *
 * `dexAddresses` is deliberately the caller's concern (see
 * `wallet-tracker.ts`'s `dexAddressesForToken`) rather than hardcoded here —
 * it's per-token (the pool address differs per launch) and mixes
 * launchpad-specific infra (NOXA/Odyssey factories) with the shared Uniswap
 * router/quoter, all sourced from real on-chain constants, never guessed.
 *
 * Known failure modes (why this needs the fixture-based precision test):
 *  - A multi-hop swap can route through an intermediate contract that isn't
 *    in `dexAddresses` (e.g. an aggregator or the NonfungiblePositionManager
 *    doing a mint-and-swap). The wallet-facing leg (wallet -> aggregator)
 *    undercounts — reads as `transfer`, dropping a real trade rather than
 *    fabricating a wrong one. But the far leg (aggregator -> pool) DOES
 *    classify as a trade (the pool side is recognized) — and attributes it
 *    to the aggregator CONTRACT address, not the real end user. This is a
 *    genuine mis-attribution, not just an undercount; see
 *    classify.test.ts's two "KNOWN BLIND SPOT" cases for the exact fixture.
 *  - A CEX hot wallet is indistinguishable from any other wallet address —
 *    a CEX withdrawal lands as `transfer`, which is correct (it's not a DEX
 *    trade), but means CEX-sourced supply looks like "no trading history"
 *    rather than being flagged as CEX-origin (see Level 4's funding graph).
 *  - `from === to` (a no-op or fee-rebate transfer some tokens emit) is
 *    classified whichever way the address-set check falls; it carries zero
 *    net value either way, so it does not distort PnL, only trade counts by
 *    a negligible amount. Documented, not fixed — vanishingly rare in
 *    practice and not worth a special case.
 */
export function classifyTransfer(
  transfer: ClassifiableTransfer,
  dexAddresses: ReadonlySet<string>,
): TransferClassification {
  const fromIsDex = dexAddresses.has(transfer.from.toLowerCase())
  const toIsDex = dexAddresses.has(transfer.to.toLowerCase())
  if (fromIsDex && !toIsDex) return 'buy'
  if (!fromIsDex && toIsDex) return 'sell'
  return 'transfer'
}

/** The wallet a classified transfer's stats should attach to — `null` for `transfer` (not a trade, no subject). */
export function subjectWallet(
  transfer: ClassifiableTransfer,
  classification: TransferClassification,
): Address | null {
  if (classification === 'buy') return transfer.to
  if (classification === 'sell') return transfer.from
  return null
}
