import { getRecentLaunches, watchLaunches, type Launch } from 'hoodchain'
import type { RpcManager } from '../chain/rpc-manager.js'
import { EventQueue } from './event-queue.js'
import { ReorgGuard } from './reorg-guard.js'

export const LAUNCH_KIND = 'launch'

export interface LaunchDetectorOptions {
  rpc: RpcManager
  queue: EventQueue
  chainId: number
  confirmations?: number
  /** Re-check whether `rpc.active` changed (failover) this often (ms). @defaultValue 5000 */
  resubscribeCheckMs?: number
  /** Blocks to backfill via `getRecentLaunches` on start / after a failover. @defaultValue 2000n */
  backfillLookbackBlocks?: bigint
  onError?: (error: Error) => void
  onLaunch?: (launch: Launch) => void
}

/** JSON-safe encoding of a {@link Launch} — `blockNumber` is a bigint, which `JSON.stringify` cannot serialize. */
export function encodeLaunchPayload(launch: Launch): Record<string, unknown> {
  return { ...launch, blockNumber: launch.blockNumber.toString() }
}

/** Inverse of {@link encodeLaunchPayload}. */
export function decodeLaunchPayload(payload: Record<string, unknown>): Launch {
  return { ...payload, blockNumber: BigInt(payload.blockNumber as string) } as unknown as Launch
}

function launchToQueueInput(launch: Launch, chainId: number) {
  return {
    chainId,
    blockNumber: launch.blockNumber,
    transactionHash: launch.transactionHash,
    discriminator: launch.token, // see EventQueue.eventId doc — no raw log index available upstream
    kind: LAUNCH_KIND,
    payload: encodeLaunchPayload(launch),
  }
}

/**
 * Feeds the durable {@link EventQueue} from two sources so no launch is ever
 * lost, even across an RPC failover or a process restart:
 *
 *  1. `watchLaunches` — the live stream, re-subscribed onto whichever
 *     endpoint {@link RpcManager} currently reports as `active`.
 *  2. `getRecentLaunches` — an RPC log backfill run on start and again right
 *     after any detected failover, covering the gap a subscription
 *     hand-off can otherwise drop. This is the "emergency fallback" tier:
 *     rather than a separate Blockscout scraper (fragile, and hoodchain
 *     exposes no such API), the emergency RPC tier's own logs are replayed
 *     for the lookback window.
 *
 * Both sources write through {@link EventQueue.recordDetected}, whose unique
 * composite key makes the overlap between "live" and "backfilled" a no-op
 * rather than a duplicate.
 */
export class LaunchDetector {
  private readonly queue: EventQueue
  private readonly reorgGuard: ReorgGuard
  private unwatch: (() => void) | null = null
  private lastLabel: string | null = null
  private resubscribeTimer: ReturnType<typeof setInterval> | null = null
  private lastSeenBlock: bigint | null = null

  constructor(private readonly opts: LaunchDetectorOptions) {
    this.queue = opts.queue
    this.reorgGuard = new ReorgGuard({
      client: opts.rpc.active,
      queue: this.queue,
      kind: LAUNCH_KIND,
      confirmations: opts.confirmations,
    })
  }

  async start(): Promise<void> {
    await this.backfill()
    this.subscribe()
    this.reorgGuard.start()
    this.resubscribeTimer = setInterval(() => void this.reconcile(), this.opts.resubscribeCheckMs ?? 5_000)
    this.resubscribeTimer.unref?.()
  }

  stop(): void {
    if (this.resubscribeTimer) clearInterval(this.resubscribeTimer)
    this.resubscribeTimer = null
    this.reorgGuard.stop()
    this.unwatch?.()
    this.unwatch = null
  }

  private onLaunch = (launch: Launch): void => {
    this.queue.recordDetected(launchToQueueInput(launch, this.opts.chainId))
    if (this.lastSeenBlock === null || launch.blockNumber > this.lastSeenBlock)
      this.lastSeenBlock = launch.blockNumber
    this.opts.onLaunch?.(launch)
  }

  private subscribe(): void {
    this.unwatch?.()
    this.lastLabel = this.opts.rpc.activeLabel
    this.unwatch = watchLaunches(this.opts.rpc.active, this.onLaunch, { onError: this.opts.onError })
  }

  private async reconcile(): Promise<void> {
    if (this.opts.rpc.activeLabel === this.lastLabel) return
    // Failover happened — re-subscribe onto the new active client and backfill
    // the gap a subscription hand-off can drop.
    this.subscribe()
    await this.backfill()
  }

  private async backfill(): Promise<void> {
    try {
      const launches = await getRecentLaunches(this.opts.rpc.active, {
        lookbackBlocks: this.opts.backfillLookbackBlocks ?? 2_000n,
      })
      for (const l of launches) this.onLaunch(l)
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
