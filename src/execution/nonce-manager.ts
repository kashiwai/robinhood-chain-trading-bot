import type { HoodClient } from 'hoodchain'
import type { Address } from 'viem'

/**
 * Serialized nonce allocation for one wallet. Reservation is a single
 * in-memory counter guarded by a promise-chain mutex (`queue`) — cheap
 * because reserving is just "read the counter, increment it", not the
 * signing/submission that follows, so serializing it costs nothing
 * meaningful even under concurrent orders.
 *
 * `release` only ever frees the HIGHEST reserved-but-unused nonce (LIFO).
 * Freeing an arbitrary earlier nonce would leave a gap that strands every
 * later, already-submitted nonce in the mempool until something eventually
 * fills it — releasing anything but the most recent reservation is refused
 * outright rather than silently creating that gap.
 */
export class NonceManager {
  private next = 0
  private highestReserved = -1
  private queue: Promise<unknown> = Promise.resolve()
  private synced = false

  constructor(
    private readonly client: HoodClient,
    private readonly account: Address,
  ) {}

  /**
   * Resolve the starting nonce from chain state. Uses `pending` (includes
   * the mempool), not `latest` (confirmed-only) — a prior process crash may
   * have left transactions broadcast but not yet mined, and starting from
   * `latest` would immediately collide with one of those on the very next
   * submission. Call once at startup, before any `reserve()`.
   */
  async sync(): Promise<void> {
    const pendingCount = await this.client.public.getTransactionCount({
      address: this.account,
      blockTag: 'pending',
    })
    this.next = pendingCount
    this.highestReserved = pendingCount - 1
    this.synced = true
  }

  /** Confirmed (mined-only) nonce count — the floor `sync()` compares against for restart reconciliation (see executor.ts). */
  async confirmedCount(): Promise<number> {
    return this.client.public.getTransactionCount({ address: this.account, blockTag: 'latest' })
  }

  /** Atomically reserve and return the next nonce. */
  async reserve(): Promise<number> {
    if (!this.synced) throw new Error('nonce-manager: reserve() called before sync()')
    const run = this.queue.then(() => {
      const n = this.next
      this.next += 1
      this.highestReserved = n
      return n
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Free a reserved nonce that was never actually broadcast (e.g. signing
   * failed, or the risk gate refused the order after reservation). Only
   * succeeds if `nonce` is still the highest one reserved — see the class
   * doc comment. Returns whether the release actually happened.
   */
  async release(nonce: number): Promise<boolean> {
    const run = this.queue.then(() => {
      if (nonce !== this.highestReserved) return false
      this.next = nonce
      this.highestReserved = nonce - 1
      return true
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
