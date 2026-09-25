import { erc20Abi, watchTransfers, type HoodClient } from 'hoodchain'
import { formatUnits, type Address } from 'viem'
import type { Market } from '../framework/market.js'
import { classifyTransfer, subjectWallet } from './classify.js'
import { WalletStore } from './wallet-store.js'

export interface TrackedTokenInfo {
  token: Address
  /** DEX/launchpad infra addresses for THIS token (pool + shared router/quoter/launchpad contracts) — see `dexAddressesForToken` below. */
  dexAddresses: ReadonlySet<string>
  /** ms epoch the token was first detected (Level 2's EventQueue `detectedAt`) — null if this token wasn't seen via our own discovery feed. */
  launchDetectedAtMs: number | null
  /** Token decimals, for USD pricing via Market.spotPrice. @defaultValue 18 */
  decimals?: number
}

export interface WalletTrackerOptions {
  client: HoodClient
  market: Pick<Market, 'spotPrice'>
  store: WalletStore
  chainId: number
  onError?: (error: Error) => void
  /** Blocks per backfill chunk (public-RPC friendly). @defaultValue 5000n */
  backfillChunkBlocks?: bigint
  /** Fired the moment a wallet records its first-ever trade — the hook point for Level 4's funding-graph resolution. */
  onFirstTrade?: (wallet: Address) => void
}

/**
 * Watches ERC-20 Transfer events for a set of tracked tokens, classifies each
 * as buy/sell/transfer (see classify.ts), and records trades into a
 * {@link WalletStore}.
 *
 * Cursor ordering (the spec's explicit requirement — a rebuild from scratch
 * of the naive "advance cursor, then act on what you read" pattern this
 * level exists to forbid):
 *
 *     RPC read (getContractEvents / watchTransfers delivers a log)
 *       -> decode (classify + price)
 *       -> DB transaction (WalletStore.recordTrade — ledger + FIFO cost
 *          basis + stats, all inside one better-sqlite3 transaction)
 *       -> commit (recordTrade returns)
 *       -> cursor update (WalletStore.advanceCursor — ONLY reached after
 *          the line above)
 *
 * A crash between "commit" and "cursor update" just means the next backfill
 * re-reads a small overlap of already-committed blocks — safe, because
 * `recordTrade` is idempotent on the real (token, txHash, logIndex) key, so
 * replaying already-seen logs is a verified no-op (see wallet-store.test.ts).
 *
 * Pricing: each buy/sell is priced via `Market.spotPrice` AT OBSERVATION
 * TIME — a live quote against real liquidity, the same primitive the rest of
 * this codebase already trusts for USD notional (see agent.ts). This is
 * accurate for a live tracker processing events as they happen; backfilled
 * (historical) fills are priced at *replay* time, not fill time, so a long
 * catch-up backfill after downtime will misprice older fills against
 * whatever the token is worth now. Getting the exact historical fill price
 * would mean decoding the pool's own Swap event (exact amount0/amount1) —
 * deliberately out of scope for Level 3; flagged here rather than silently
 * shipped as if it were exact.
 */
export class WalletTracker {
  private readonly tracked = new Map<string, { info: TrackedTokenInfo; unwatch: (() => void) | null }>()
  private readonly totalSupplyCache = new Map<string, bigint>()

  constructor(private readonly opts: WalletTrackerOptions) {}

  async track(info: TrackedTokenInfo): Promise<void> {
    const key = info.token.toLowerCase()
    if (this.tracked.has(key)) return
    this.tracked.set(key, { info, unwatch: null })

    await this.backfill(info)
    const unwatch = watchTransfers(
      this.opts.client,
      { token: info.token },
      (transfer) =>
        void this.handle(
          info,
          transfer.from,
          transfer.to,
          transfer.value,
          transfer.blockNumber,
          transfer.transactionHash,
          null,
        ),
    )
    const entry = this.tracked.get(key)
    if (entry) entry.unwatch = unwatch
    else unwatch() // untrack() raced us while backfill() was awaiting
  }

  untrack(token: Address): void {
    const key = token.toLowerCase()
    const entry = this.tracked.get(key)
    entry?.unwatch?.()
    this.tracked.delete(key)
  }

  stop(): void {
    for (const [key] of this.tracked) this.untrack(key as Address)
  }

  private async backfill(info: TrackedTokenInfo): Promise<void> {
    try {
      const cursor = this.opts.store.cursorFor(info.token)
      const latest = await this.opts.client.public.getBlockNumber()
      const fromBlock = cursor !== null ? cursor + 1n : latest > 5_000n ? latest - 5_000n : 0n
      if (fromBlock > latest) return

      const chunk = this.opts.backfillChunkBlocks ?? 5_000n
      for (let start = fromBlock; start <= latest; start += chunk + 1n) {
        const end = start + chunk <= latest ? start + chunk : latest
        const logs = await this.opts.client.public.getContractEvents({
          address: info.token,
          abi: erc20Abi,
          eventName: 'Transfer',
          fromBlock: start,
          toBlock: end,
        })
        for (const log of logs) {
          if (!log.args.from || !log.args.to || log.args.value === undefined) continue
          await this.handle(
            info,
            log.args.from,
            log.args.to,
            log.args.value,
            log.blockNumber,
            log.transactionHash,
            log.logIndex,
          )
        }
        this.opts.store.advanceCursor(info.token, end)
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async handle(
    info: TrackedTokenInfo,
    from: Address,
    to: Address,
    value: bigint,
    blockNumber: bigint,
    transactionHash: string,
    logIndex: number | null,
  ): Promise<void> {
    const classification = classifyTransfer({ from, to }, info.dexAddresses)
    if (classification === 'transfer') return
    const wallet = subjectWallet({ from, to }, classification)
    if (!wallet) return

    try {
      const decimals = info.decimals ?? 18
      const spot = await this.opts.market.spotPrice(info.token, decimals)
      const amountTokens = Number(formatUnits(value, decimals))
      const amountUsd = spot ? amountTokens * spot.priceUsd : 0
      const mcapUsd = spot ? spot.priceUsd * (await this.totalSupply(info.token)) : null
      const now = Date.now()
      const secondsSinceLaunch =
        info.launchDetectedAtMs === null ? null : (now - info.launchDetectedAtMs) / 1000

      // RPC read (caller) -> decode (classify, above) -> DB transaction + commit:
      const wasNew = this.opts.store.recordTrade({
        token: info.token,
        wallet,
        side: classification,
        amountTokenWei: value.toString(),
        amountUsd,
        mcapUsd,
        blockNumber,
        transactionHash,
        logIndex: logIndex ?? syntheticLogIndex(transactionHash, from, to, value),
        ts: now,
        secondsSinceLaunch,
      })
      // cursor update happens in backfill() after the whole chunk commits (live-watch path has no cursor to advance — see class doc).
      if (wasNew && this.opts.store.get(wallet)?.totalTrades === 1) this.opts.onFirstTrade?.(wallet)
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async totalSupply(token: Address): Promise<number> {
    const key = token.toLowerCase()
    const cached = this.totalSupplyCache.get(key)
    if (cached !== undefined) return Number(formatUnits(cached, 18))
    const supply = await this.opts.client.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'totalSupply',
    })
    this.totalSupplyCache.set(key, supply)
    return Number(formatUnits(supply, 18))
  }
}

/**
 * `watchTransfers` (the live path) doesn't surface a log index — unlike the
 * backfill path's `getContractEvents`, which has a real one. Deriving a
 * stable synthetic index from the transfer's own fields keeps the live path
 * idempotent under the same (token, txHash, logIndex) uniqueness constraint,
 * at the honestly-documented cost of colliding if the exact same (from, to,
 * value) pair appears twice in one transaction — rare, and the second such
 * transfer is dropped as a false-duplicate rather than mis-recorded twice.
 */
function syntheticLogIndex(transactionHash: string, from: Address, to: Address, value: bigint): number {
  const s = `${transactionHash}:${from.toLowerCase()}:${to.toLowerCase()}:${value}`
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
  return (hash & 0x7fffffff) + 1_000_000_000 // offset clear of real (small) log indices from the backfill path
}

/** Build the DEX/launchpad address set for one token — see classify.ts's doc comment for why this is per-token. */
export function dexAddressesForToken(
  pool: Address | null,
  sharedInfra: readonly Address[],
): ReadonlySet<string> {
  const set = new Set<string>(sharedInfra.map((a) => a.toLowerCase()))
  if (pool) set.add(pool.toLowerCase())
  return set
}
