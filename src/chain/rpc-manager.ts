import { webSocket, type Transport } from 'viem'
import { createHoodClient, type HoodClient, type HoodNetwork } from 'hoodchain'
import { httpTransport } from './http-transport.js'

export type RpcTier = 'primary' | 'secondary' | 'emergency'

export interface RpcHealth {
  label: string
  tier: RpcTier
  healthy: boolean
  lastCheckedAt: number | null
  lastError: string | null
  latencyMs: number | null
}

export interface RpcManagerOptions {
  network: HoodNetwork
  /** wss:// endpoint — true `eth_subscribe` push, no poll latency. Primary tier. */
  wsRpcUrl?: string
  /** https:// endpoint (e.g. a paid Alchemy URL). Secondary tier, 2s-poll realtime. */
  httpRpcUrl?: string
  stockTokenEligible?: boolean
  /** @defaultValue 15000 */
  healthCheckIntervalMs?: number
  /** @defaultValue 5000 */
  healthCheckTimeoutMs?: number
  clock?: () => number
}

export interface Endpoint {
  tier: RpcTier
  label: string
  client: HoodClient
}

/**
 * RPC redundancy for the DISCOVERY path (event watching):
 *   1. primary   — `wsRpcUrl`, a true WebSocket transport (push, not polled)
 *   2. secondary — `httpRpcUrl`, a custom HTTP endpoint (e.g. Alchemy)
 *   3. emergency — the chain's baked-in public RPC (viem's official chain def;
 *      always present, needs no config)
 *
 * Either of the first two is optional; the emergency tier is always
 * constructed so there is never a zero-endpoint state. Health is checked on
 * an interval via a cheap `getBlockNumber()` call; the active endpoint is the
 * highest-priority one currently reporting healthy.
 *
 * Execution-path RPC redundancy (order submission) is a separate concern —
 * see Level 6 — and is intentionally NOT handled by this class.
 */
export class RpcManager {
  private readonly endpoints: Endpoint[]
  private readonly health = new Map<string, RpcHealth>()
  private readonly checkIntervalMs: number
  private readonly checkTimeoutMs: number
  private readonly clock: () => number
  private activeIndex = 0
  private timer: ReturnType<typeof setInterval> | null = null

  private constructor(
    endpoints: Endpoint[],
    opts: Pick<RpcManagerOptions, 'healthCheckIntervalMs' | 'healthCheckTimeoutMs' | 'clock'>,
  ) {
    this.checkIntervalMs = opts.healthCheckIntervalMs ?? 15_000
    this.checkTimeoutMs = opts.healthCheckTimeoutMs ?? 5_000
    this.clock = opts.clock ?? Date.now
    this.endpoints = endpoints
    for (const e of this.endpoints) {
      this.health.set(e.label, {
        label: e.label,
        tier: e.tier,
        healthy: true,
        lastCheckedAt: null,
        lastError: null,
        latencyMs: null,
      })
    }
  }

  static create(opts: RpcManagerOptions): RpcManager {
    return new RpcManager(buildEndpoints(opts), opts)
  }

  /**
   * Test/advanced seam: build an RpcManager from already-constructed
   * endpoints instead of resolving them from URLs. Lets unit tests substitute
   * fake `HoodClient`-shaped objects (e.g. one whose `getBlockNumber` rejects
   * on demand) to exercise failover deterministically, with no real network
   * calls or a live WebSocket endpoint required.
   */
  static fromEndpoints(
    endpoints: Endpoint[],
    opts: Pick<RpcManagerOptions, 'healthCheckIntervalMs' | 'healthCheckTimeoutMs' | 'clock'> = {},
  ): RpcManager {
    return new RpcManager(endpoints, opts)
  }

  get active(): HoodClient {
    return this.endpoints[this.activeIndex]!.client
  }

  get activeLabel(): string {
    return this.endpoints[this.activeIndex]!.label
  }

  get activeTier(): RpcTier {
    return this.endpoints[this.activeIndex]!.tier
  }

  healthSnapshot(): RpcHealth[] {
    return [...this.health.values()]
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.checkAll(), this.checkIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Run one health-check pass across every endpoint and reconcile `active`. Exposed for tests. */
  async checkAll(): Promise<void> {
    for (const e of this.endpoints) {
      const started = this.clock()
      try {
        await withTimeout(e.client.public.getBlockNumber(), this.checkTimeoutMs)
        this.health.set(e.label, {
          label: e.label,
          tier: e.tier,
          healthy: true,
          lastCheckedAt: this.clock(),
          lastError: null,
          latencyMs: this.clock() - started,
        })
      } catch (err) {
        this.health.set(e.label, {
          label: e.label,
          tier: e.tier,
          healthy: false,
          lastCheckedAt: this.clock(),
          lastError: err instanceof Error ? err.message : String(err),
          latencyMs: null,
        })
      }
    }
    this.reconcileActive()
  }

  private reconcileActive(): void {
    for (let i = 0; i < this.endpoints.length; i++) {
      if (this.health.get(this.endpoints[i]!.label)!.healthy) {
        this.activeIndex = i
        return
      }
    }
    // Nothing healthy right now — stay put. Downstream simulate/risk gates
    // still refuse any trade that can't get a real quote, so a stale client
    // fails closed rather than trading blind.
  }
}

function buildEndpoints(opts: RpcManagerOptions): Endpoint[] {
  const endpoints: Endpoint[] = []
  const clientFor = (transport: Transport): HoodClient =>
    createHoodClient({
      chain: opts.network,
      transport,
      acknowledgeStockTokenEligibility: opts.stockTokenEligible ?? false,
    })

  if (opts.wsRpcUrl) {
    endpoints.push({
      tier: 'primary',
      label: `ws:${redact(opts.wsRpcUrl)}`,
      client: clientFor(webSocket(opts.wsRpcUrl)),
    })
  }
  if (opts.httpRpcUrl) {
    endpoints.push({
      tier: 'secondary',
      label: `http:${redact(opts.httpRpcUrl)}`,
      client: clientFor(httpTransport(opts.httpRpcUrl)),
    })
  }
  // httpTransport(undefined) resolves to the chain's baked-in public RPC — see
  // chain/http-transport.ts for why the User-Agent override is required here.
  endpoints.push({
    tier: 'emergency',
    label: 'http:public-default',
    client: clientFor(httpTransport(undefined)),
  })
  return endpoints
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rpc health check timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** Strip query string / userinfo so API keys embedded in the URL never reach logs or the dashboard. */
function redact(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return '(unparseable-rpc-url)'
  }
}
