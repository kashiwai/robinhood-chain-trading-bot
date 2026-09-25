import { describe, expect, it } from 'vitest'
import type { HoodClient } from 'hoodchain'
import { RpcManager, type Endpoint } from '../../src/chain/rpc-manager.js'

/** A fake HoodClient exposing only what RpcManager touches: `public.getBlockNumber()`. */
function fakeClient(behavior: () => Promise<bigint>): HoodClient {
  return { public: { getBlockNumber: behavior } } as unknown as HoodClient
}

function endpoint(tier: Endpoint['tier'], label: string, behavior: () => Promise<bigint>): Endpoint {
  return { tier, label, client: fakeClient(behavior) }
}

describe('RpcManager — discovery-path RPC redundancy', () => {
  it('starts on the highest-priority (primary) endpoint', async () => {
    const mgr = RpcManager.fromEndpoints([
      endpoint('primary', 'ws:primary', async () => 100n),
      endpoint('secondary', 'http:secondary', async () => 100n),
      endpoint('emergency', 'http:emergency', async () => 100n),
    ])
    await mgr.checkAll()
    expect(mgr.activeTier).toBe('primary')
    expect(mgr.activeLabel).toBe('ws:primary')
  })

  it('fails over to secondary when primary is unhealthy, and reports it in the health snapshot', async () => {
    const mgr = RpcManager.fromEndpoints([
      endpoint('primary', 'ws:primary', async () => {
        throw new Error('connection refused')
      }),
      endpoint('secondary', 'http:secondary', async () => 100n),
      endpoint('emergency', 'http:emergency', async () => 100n),
    ])
    await mgr.checkAll()
    expect(mgr.activeTier).toBe('secondary')

    const snapshot = mgr.healthSnapshot()
    const primary = snapshot.find((h) => h.label === 'ws:primary')
    expect(primary?.healthy).toBe(false)
    expect(primary?.lastError).toMatch(/connection refused/)
  })

  it('falls all the way through to the emergency tier when both primary and secondary are down', async () => {
    const mgr = RpcManager.fromEndpoints([
      endpoint('primary', 'ws:primary', async () => {
        throw new Error('down')
      }),
      endpoint('secondary', 'http:secondary', async () => {
        throw new Error('down')
      }),
      endpoint('emergency', 'http:emergency', async () => 100n),
    ])
    await mgr.checkAll()
    expect(mgr.activeTier).toBe('emergency')
  })

  it('reconnects automatically: recovers to primary once it starts answering again', async () => {
    let primaryUp = false
    const mgr = RpcManager.fromEndpoints([
      endpoint('primary', 'ws:primary', async () => {
        if (!primaryUp) throw new Error('still down')
        return 200n
      }),
      endpoint('secondary', 'http:secondary', async () => 100n),
      endpoint('emergency', 'http:emergency', async () => 100n),
    ])

    await mgr.checkAll()
    expect(mgr.activeTier).toBe('secondary') // primary down at first check

    primaryUp = true
    await mgr.checkAll()
    expect(mgr.activeTier).toBe('primary') // recovered on the next health-check pass
  })

  it('stays on the last active endpoint if every endpoint is currently unhealthy (fails closed, not to nothing)', async () => {
    const mgr = RpcManager.fromEndpoints([
      endpoint('primary', 'ws:primary', async () => {
        throw new Error('down')
      }),
      endpoint('secondary', 'http:secondary', async () => {
        throw new Error('down')
      }),
      endpoint('emergency', 'http:emergency', async () => {
        throw new Error('down')
      }),
    ])
    await mgr.checkAll()
    // activeIndex never moves off its last value (0 = primary) when nothing is healthy.
    expect(mgr.activeLabel).toBe('ws:primary')
    expect(mgr.healthSnapshot().every((h) => !h.healthy)).toBe(true)
  })

  it('a slow endpoint that exceeds the health-check timeout is treated as unhealthy', async () => {
    const mgr = RpcManager.fromEndpoints(
      [
        endpoint(
          'primary',
          'ws:primary',
          () => new Promise((resolve) => setTimeout(() => resolve(100n), 50)),
        ),
        endpoint('secondary', 'http:secondary', async () => 100n),
        endpoint('emergency', 'http:emergency', async () => 100n),
      ],
      { healthCheckTimeoutMs: 5 },
    )
    await mgr.checkAll()
    expect(mgr.activeTier).toBe('secondary')
    expect(mgr.healthSnapshot().find((h) => h.label === 'ws:primary')?.lastError).toMatch(/timed out/)
  })
})
