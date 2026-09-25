import { describe, expect, it } from 'vitest'
import type { HoodClient } from 'hoodchain'
import { EventQueue } from '../../src/discovery/event-queue.js'
import { ReorgGuard } from '../../src/discovery/reorg-guard.js'

function fakeClient(opts: {
  blockNumber: bigint
  receipts: Map<string, { blockNumber: bigint } | undefined>
}): HoodClient {
  return {
    public: {
      getBlockNumber: async () => opts.blockNumber,
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        const r = opts.receipts.get(hash)
        if (!r) throw new Error(`receipt not found for ${hash}`)
        return r
      },
    },
  } as unknown as HoodClient
}

describe('ReorgGuard — confirmation gate between detected and queued', () => {
  it('does not promote an event until it has enough confirmations', async () => {
    const queue = new EventQueue(':memory:')
    const id = queue.recordDetected({
      chainId: 4663,
      blockNumber: 100n,
      transactionHash: '0xabc',
      discriminator: 'tok',
      kind: 'launch',
      payload: {},
    })!
    const client = fakeClient({ blockNumber: 101n, receipts: new Map([['0xabc', { blockNumber: 100n }]]) })
    const guard = new ReorgGuard({ client, queue, kind: 'launch', confirmations: 3 })

    const result = await guard.sweep()
    expect(result).toEqual({ promoted: 0, reorged: 0 })
    expect(queue.get(id)?.state).toBe('detected')
  })

  it('promotes to queued once confirmations are met and the transaction is still present', async () => {
    const queue = new EventQueue(':memory:')
    const id = queue.recordDetected({
      chainId: 4663,
      blockNumber: 100n,
      transactionHash: '0xabc',
      discriminator: 'tok',
      kind: 'launch',
      payload: {},
    })!
    const client = fakeClient({ blockNumber: 103n, receipts: new Map([['0xabc', { blockNumber: 100n }]]) })
    const guard = new ReorgGuard({ client, queue, kind: 'launch', confirmations: 3 })

    const result = await guard.sweep()
    expect(result).toEqual({ promoted: 1, reorged: 0 })
    expect(queue.get(id)?.state).toBe('queued')
    expect(queue.get(id)?.queuedAt).not.toBeNull()
  })

  it('rejects with a reorg reason when the transaction has vanished after the confirmation window', async () => {
    const queue = new EventQueue(':memory:')
    const id = queue.recordDetected({
      chainId: 4663,
      blockNumber: 100n,
      transactionHash: '0xabc',
      discriminator: 'tok',
      kind: 'launch',
      payload: {},
    })!
    // No entry in receipts map -> getTransactionReceipt throws "not found", simulating a reorged-away tx.
    const client = fakeClient({ blockNumber: 103n, receipts: new Map() })
    const guard = new ReorgGuard({ client, queue, kind: 'launch', confirmations: 3 })

    const result = await guard.sweep()
    expect(result).toEqual({ promoted: 0, reorged: 1 })
    const row = queue.get(id)
    expect(row?.state).toBe('rejected')
    expect(row?.error).toMatch(/reorg/)
  })

  it('rejects when the tx hash was re-mined into a different block (a real reorg, not just a missing receipt)', async () => {
    const queue = new EventQueue(':memory:')
    const id = queue.recordDetected({
      chainId: 4663,
      blockNumber: 100n,
      transactionHash: '0xabc',
      discriminator: 'tok',
      kind: 'launch',
      payload: {},
    })!
    const client = fakeClient({ blockNumber: 103n, receipts: new Map([['0xabc', { blockNumber: 101n }]]) })
    const guard = new ReorgGuard({ client, queue, kind: 'launch', confirmations: 3 })

    const result = await guard.sweep()
    expect(result).toEqual({ promoted: 0, reorged: 1 })
    expect(queue.get(id)?.state).toBe('rejected')
    expect(queue.get(id)?.error).toMatch(/re-mined/)
  })

  it('every detected event reaches a terminal disposition across a mixed batch — none silently vanish', async () => {
    const queue = new EventQueue(':memory:')
    const confirmedId = queue.recordDetected({
      chainId: 4663,
      blockNumber: 100n,
      transactionHash: '0xok',
      discriminator: 'ok',
      kind: 'launch',
      payload: {},
    })!
    const reorgedId = queue.recordDetected({
      chainId: 4663,
      blockNumber: 100n,
      transactionHash: '0xgone',
      discriminator: 'gone',
      kind: 'launch',
      payload: {},
    })!
    const notYetId = queue.recordDetected({
      chainId: 4663,
      blockNumber: 102n, // only 1 confirmation deep at block 103 with confirmations=3
      transactionHash: '0xtooyoung',
      discriminator: 'tooyoung',
      kind: 'launch',
      payload: {},
    })!

    const client = fakeClient({
      blockNumber: 103n,
      receipts: new Map([['0xok', { blockNumber: 100n }]]),
    })
    const guard = new ReorgGuard({ client, queue, kind: 'launch', confirmations: 3 })
    await guard.sweep()

    expect(queue.get(confirmedId)?.state).toBe('queued')
    expect(queue.get(reorgedId)?.state).toBe('rejected')
    expect(queue.get(notYetId)?.state).toBe('detected') // correctly still waiting — not lost, not wrongly promoted
  })
})
