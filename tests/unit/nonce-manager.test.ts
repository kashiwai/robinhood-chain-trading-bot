import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { HoodClient } from 'hoodchain'
import { NonceManager } from '../../src/execution/nonce-manager.js'

const ACCOUNT = '0x1111111111111111111111111111111111111a' as Address

function fakeClient(pendingCount: number, latestCount = pendingCount): HoodClient {
  return {
    public: {
      getTransactionCount: async ({ blockTag }: { blockTag: 'pending' | 'latest' }) =>
        blockTag === 'pending' ? pendingCount : latestCount,
    },
  } as unknown as HoodClient
}

describe('NonceManager', () => {
  it('sync() starts from the PENDING count, not the confirmed count — avoids colliding with a mempool tx from a prior crash', async () => {
    const client = fakeClient(7, 5) // 5 confirmed, 2 more sitting unconfirmed in the mempool
    const mgr = new NonceManager(client, ACCOUNT)
    await mgr.sync()
    const first = await mgr.reserve()
    expect(first).toBe(7)
  })

  it('reserve() hands out strictly sequential nonces', async () => {
    const client = fakeClient(0)
    const mgr = new NonceManager(client, ACCOUNT)
    await mgr.sync()
    const nonces = [await mgr.reserve(), await mgr.reserve(), await mgr.reserve()]
    expect(nonces).toEqual([0, 1, 2])
  })

  it('concurrent reserve() calls never collide, even racing', async () => {
    const client = fakeClient(0)
    const mgr = new NonceManager(client, ACCOUNT)
    await mgr.sync()
    const results = await Promise.all(Array.from({ length: 20 }, () => mgr.reserve()))
    const unique = new Set(results)
    expect(unique.size).toBe(20) // no duplicates
    expect([...unique].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('release() frees the most-recently-reserved nonce for reuse', async () => {
    const client = fakeClient(0)
    const mgr = new NonceManager(client, ACCOUNT)
    await mgr.sync()
    const n1 = await mgr.reserve() // 0
    const n2 = await mgr.reserve() // 1
    const released = await mgr.release(n2)
    expect(released).toBe(true)
    const n3 = await mgr.reserve()
    expect(n3).toBe(n2) // reused, not skipped
    expect(n1).toBe(0)
  })

  it('release() REFUSES to free a nonce that is no longer the highest reserved — would create a gap', async () => {
    const client = fakeClient(0)
    const mgr = new NonceManager(client, ACCOUNT)
    await mgr.sync()
    const n1 = await mgr.reserve() // 0
    await mgr.reserve() // 1 — now the highest
    const released = await mgr.release(n1) // trying to free 0, but 1 is already reserved on top of it
    expect(released).toBe(false)
    const n3 = await mgr.reserve()
    expect(n3).toBe(2) // sequence continues untouched — no gap opened
  })

  it('reserve() before sync() throws rather than silently starting from 0 against real chain state', async () => {
    const client = fakeClient(0)
    const mgr = new NonceManager(client, ACCOUNT)
    await expect(mgr.reserve()).rejects.toThrow(/sync/)
  })

  it('confirmedCount() reads the latest (mined-only) count independently of the pending-based reservation floor', async () => {
    const client = fakeClient(7, 5)
    const mgr = new NonceManager(client, ACCOUNT)
    await mgr.sync()
    expect(await mgr.confirmedCount()).toBe(5)
  })
})
