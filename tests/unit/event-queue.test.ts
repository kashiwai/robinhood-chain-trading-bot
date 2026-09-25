import { describe, expect, it } from 'vitest'
import { EventQueue, type QueueEventInput } from '../../src/discovery/event-queue.js'

function input(overrides: Partial<QueueEventInput> = {}): QueueEventInput {
  return {
    chainId: 4663,
    blockNumber: 100n,
    transactionHash: '0xabc',
    discriminator: '0xtoken',
    kind: 'launch',
    payload: { hello: 'world' },
    ...overrides,
  }
}

describe('EventQueue — durable discovery queue', () => {
  it('recordDetected persists a new event in state=detected', () => {
    const q = new EventQueue(':memory:')
    const id = q.recordDetected(input())
    expect(id).not.toBeNull()
    const row = q.get(id!)
    expect(row?.state).toBe('detected')
    expect(row?.detectedAt).toBeGreaterThan(0)
    expect(row?.blockNumber).toBe(100n)
  })

  it('is idempotent on the composite key — a duplicate insert is a no-op, not a second row', () => {
    const q = new EventQueue(':memory:')
    const first = q.recordDetected(input())
    const second = q.recordDetected(input()) // identical chainId/blockNumber/txHash/discriminator
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(q.stateCounts().detected).toBe(1)
  })

  it('a different discriminator on the same block/tx is a distinct event', () => {
    const q = new EventQueue(':memory:')
    const a = q.recordDetected(input({ discriminator: '0xtokenA' }))
    const b = q.recordDetected(input({ discriminator: '0xtokenB' }))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
    expect(q.stateCounts().detected).toBe(2)
  })

  it('walks the full lifecycle: detected -> queued -> processing -> enriched -> decisioned', () => {
    const q = new EventQueue(':memory:')
    const id = q.recordDetected(input())!
    q.markQueued(id)
    expect(q.get(id)?.state).toBe('queued')

    const claimed = q.claimNext('launch')
    expect(claimed?.eventId).toBe(id)
    expect(claimed?.state).toBe('processing')
    expect(claimed?.attempts).toBe(1)

    q.markEnriched(id)
    expect(q.get(id)?.state).toBe('enriched')
    expect(q.get(id)?.enrichedAt).not.toBeNull()

    q.markDecisioned(id)
    expect(q.get(id)?.state).toBe('decisioned')
    expect(q.get(id)?.decisionedAt).not.toBeNull()

    q.markTraded(id)
    expect(q.get(id)?.state).toBe('traded')
    expect(q.get(id)?.orderSubmittedAt).not.toBeNull()
  })

  it('claimNext only returns queued events, oldest first, and never the same row twice', () => {
    const q = new EventQueue(':memory:')
    const idA = q.recordDetected(input({ discriminator: 'A' }))!
    q.markQueued(idA, 1000)
    const idB = q.recordDetected(input({ discriminator: 'B' }))!
    q.markQueued(idB, 2000)

    const first = q.claimNext('launch')
    expect(first?.eventId).toBe(idA) // older queuedAt/detectedAt first
    const second = q.claimNext('launch')
    expect(second?.eventId).toBe(idB)
    const third = q.claimNext('launch')
    expect(third).toBeNull() // nothing left queued
  })

  it('claimNext ignores other kinds', () => {
    const q = new EventQueue(':memory:')
    const id = q.recordDetected(input({ kind: 'curve-trade' }))!
    q.markQueued(id)
    expect(q.claimNext('launch')).toBeNull()
    expect(q.claimNext('curve-trade')?.eventId).toBe(id)
  })

  it('markRejected/markError only apply from processing or enriched — a bare "detected" row cannot skip straight to a terminal state', () => {
    const q = new EventQueue(':memory:')
    const id = q.recordDetected(input())!
    q.markRejected(id, 'should not apply yet')
    expect(q.get(id)?.state).toBe('detected') // unchanged — no-op transition
  })

  it('markReorged moves a detected row straight to rejected with the reorg reason recorded', () => {
    const q = new EventQueue(':memory:')
    const id = q.recordDetected(input())!
    q.markReorged(id, 'reorg: transaction vanished')
    const row = q.get(id)
    expect(row?.state).toBe('rejected')
    expect(row?.error).toMatch(/reorg/)
  })

  it('stateCounts reflects every terminal outcome so nothing is silently lost', () => {
    const q = new EventQueue(':memory:')
    const traded = q.recordDetected(input({ discriminator: 'traded' }))!
    q.markQueued(traded)
    q.claimNext('launch')
    q.markDecisioned(traded)
    q.markTraded(traded)

    const rejected = q.recordDetected(input({ discriminator: 'rejected' }))!
    q.markQueued(rejected)
    q.claimNext('launch')
    q.markRejected(rejected, 'no route')

    const errored = q.recordDetected(input({ discriminator: 'errored' }))!
    q.markQueued(errored)
    q.claimNext('launch')
    q.markError(errored, 'boom')

    const counts = q.stateCounts('launch')
    expect(counts.traded).toBe(1)
    expect(counts.rejected).toBe(1)
    expect(counts.error).toBe(1)
    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    expect(total).toBe(3)
  })

  it('detected() returns only rows still awaiting confirmation, scoped by kind', () => {
    const q = new EventQueue(':memory:')
    const pending = q.recordDetected(input({ discriminator: 'pending' }))!
    const promoted = q.recordDetected(input({ discriminator: 'promoted' }))!
    q.markQueued(promoted)
    const other = q.recordDetected(input({ discriminator: 'other-kind', kind: 'curve-trade' }))!
    q.markQueued(other)

    const stillDetected = q.detected('launch')
    expect(stillDetected.map((r) => r.eventId)).toEqual([pending])
  })
})
