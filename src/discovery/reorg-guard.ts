import type { HoodClient } from 'hoodchain'
import type { EventQueue } from './event-queue.js'

export interface ReorgGuardOptions {
  client: HoodClient
  queue: EventQueue
  kind: string
  /** Blocks of depth required before a `detected` event is trusted. @defaultValue 3 */
  confirmations?: number
  /** How often to sweep `detected` rows for confirmation. @defaultValue 4000 */
  sweepIntervalMs?: number
  clock?: () => number
}

/**
 * Confirmation gate between `detected` and `queued`. A freshly detected event
 * is NOT immediately actionable — the block it landed in could still be
 * reorged out. This sweeps every `detected` row and, once
 * `blockNumber + confirmations <= latest block`, re-checks that the
 * transaction is still present on-chain before promoting it to `queued`. If
 * the transaction has disappeared, the event is marked `rejected` with a
 * `reorg` reason instead of silently vanishing (every event still reaches a
 * terminal state — see the replay test's "0 lost events" assertion).
 */
export class ReorgGuard {
  private readonly confirmations: number
  private readonly sweepIntervalMs: number
  private readonly clock: () => number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: ReorgGuardOptions) {
    this.confirmations = opts.confirmations ?? 3
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 4_000
    this.clock = opts.clock ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep(), this.sweepIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Run one confirmation sweep now. Exposed directly for deterministic tests. */
  async sweep(): Promise<{ promoted: number; reorged: number }> {
    const pending = this.opts.queue.detected(this.opts.kind)
    if (pending.length === 0) return { promoted: 0, reorged: 0 }

    const latest = await this.opts.client.public.getBlockNumber()
    let promoted = 0
    let reorged = 0

    for (const ev of pending) {
      if (latest < ev.blockNumber + BigInt(this.confirmations)) continue // not confirmation-safe yet

      try {
        const receipt = await this.opts.client.public.getTransactionReceipt({
          hash: ev.transactionHash as `0x${string}`,
        })
        if (receipt.blockNumber === ev.blockNumber) {
          this.opts.queue.markQueued(ev.eventId, this.clock())
          promoted++
        } else {
          // Same tx hash landed in a different block after a reorg — treat as gone.
          this.opts.queue.markReorged(
            ev.eventId,
            `reorg: tx re-mined in block ${receipt.blockNumber} (expected ${ev.blockNumber})`,
          )
          reorged++
        }
      } catch {
        // Receipt no longer resolvable — the block/tx was reorged away.
        this.opts.queue.markReorged(
          ev.eventId,
          `reorg: transaction ${ev.transactionHash} not found after ${this.confirmations} confirmations`,
        )
        reorged++
      }
    }
    return { promoted, reorged }
  }
}
