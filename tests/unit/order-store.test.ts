import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { OrderStore, type OrderInput } from '../../src/execution/order-store.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address

function order(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    idempotencyKey: 'sig-1',
    agentId: 'sniper-1',
    token: TOKEN,
    side: 'buy',
    quoteToken: WETH,
    amountIn: '1000000000000000',
    ...overrides,
  }
}

describe('OrderStore — idempotency and lifecycle', () => {
  it('createOrder is idempotent: a second call with the same key returns the existing row, does not insert twice', () => {
    const store = new OrderStore(':memory:')
    const first = store.createOrder(order())
    expect(first.created).toBe(true)
    expect(first.row.state).toBe('CREATED')

    const second = store.createOrder(order({ amountIn: '999999999999999' })) // even with different fields
    expect(second.created).toBe(false)
    expect(second.row.amountIn).toBe(1000000000000000n) // original values preserved, not overwritten
  })

  it('walks the full lifecycle in order', () => {
    const store = new OrderStore(':memory:')
    const { row } = store.createOrder(order())
    const key = row.idempotencyKey

    store.transition(key, 'CHECKED')
    store.transition(key, 'QUOTED', { quotedAmountOut: 950n })
    store.transition(key, 'SIGNED')
    store.transition(key, 'SUBMITTED', { nonce: 5, txHash: '0xabc' })
    store.transition(key, 'MINED')
    store.transition(key, 'CONFIRMED')
    store.transition(key, 'RECONCILED', { actualAmountOut: 940n, actualPrice: 1.05, actualSlippageBps: 105 })

    const final = store.get(key)!
    expect(final.state).toBe('RECONCILED')
    expect(final.nonce).toBe(5)
    expect(final.txHash).toBe('0xabc')
    expect(final.quotedAmountOut).toBe(950n)
    expect(final.actualAmountOut).toBe(940n)
    expect(final.submittedAt).not.toBeNull()
    expect(final.minedAt).not.toBeNull()
    expect(final.confirmedAt).not.toBeNull()
    expect(final.reconciledAt).not.toBeNull()
    expect(final.attempts).toBe(1)
  })

  it('a terminal state (RECONCILED/FAILED/CANCELLED) never transitions further — a stray late event is a no-op', () => {
    const store = new OrderStore(':memory:')
    const { row } = store.createOrder(order())
    store.transition(row.idempotencyKey, 'FAILED', { error: 'reverted' })
    store.transition(row.idempotencyKey, 'SUBMITTED', { nonce: 1 }) // stray late event, must not resurrect it
    expect(store.get(row.idempotencyKey)!.state).toBe('FAILED')
    expect(store.get(row.idempotencyKey)!.nonce).toBeNull()
  })

  it('pending() returns only non-terminal orders — the restart-recovery scan set', () => {
    const store = new OrderStore(':memory:')
    const a = store.createOrder(order({ idempotencyKey: 'a' })).row
    const b = store.createOrder(order({ idempotencyKey: 'b' })).row
    store.createOrder(order({ idempotencyKey: 'c' }))
    store.transition(b.idempotencyKey, 'RECONCILED')
    store.transition(store.get('c')!.idempotencyKey, 'FAILED')

    const pending = store.pending()
    expect(pending.map((o) => o.idempotencyKey)).toEqual([a.idempotencyKey])
  })

  it('attempts increments once per SUBMITTED transition, tracking resubmission count', () => {
    const store = new OrderStore(':memory:')
    const { row } = store.createOrder(order())
    store.transition(row.idempotencyKey, 'SUBMITTED', { nonce: 1, txHash: '0x1' })
    expect(store.get(row.idempotencyKey)!.attempts).toBe(1)
  })
})
