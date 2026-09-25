import { describe, expect, it, vi } from 'vitest'
import { CircuitBreaker } from '../../src/risk/circuit-breaker.js'

describe('CircuitBreaker — BUY_PAUSED / SELL_ENABLED', () => {
  it('starts clear: buys are not paused', () => {
    const cb = new CircuitBreaker()
    expect(cb.buyPaused()).toBe(false)
  })

  it('tripping any one of the nine named conditions pauses buys', () => {
    const cb = new CircuitBreaker()
    cb.trip('rpc_unhealthy', 'primary and secondary both down')
    expect(cb.buyPaused()).toBe(true)
    expect(cb.isTripped('rpc_unhealthy')).toBe(true)
  })

  it('clearing the only tripped condition re-enables buys', () => {
    const cb = new CircuitBreaker()
    cb.trip('database_error', 'sqlite disk full')
    expect(cb.buyPaused()).toBe(true)
    cb.clear('database_error')
    expect(cb.buyPaused()).toBe(false)
  })

  it('multiple simultaneous conditions all show up, and buys stay paused until EVERY one clears', () => {
    const cb = new CircuitBreaker()
    cb.trip('sell_failure', 'a')
    cb.trip('nonce_failure', 'b')
    expect(cb.activeConditions()).toHaveLength(2)
    cb.clear('sell_failure')
    expect(cb.buyPaused()).toBe(true) // nonce_failure still tripped
    cb.clear('nonce_failure')
    expect(cb.buyPaused()).toBe(false)
  })

  it('re-tripping an already-tripped condition updates its detail but does not fire onTrip again', () => {
    const cb = new CircuitBreaker()
    const listener = vi.fn()
    cb.onTrip(listener)
    cb.trip('daily_loss_exceeded', 'first')
    cb.trip('daily_loss_exceeded', 'second')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cb.activeConditions()[0]?.detail).toBe('second')
  })

  it('onTrip fires once per NEWLY tripped condition', () => {
    const cb = new CircuitBreaker()
    const seen: string[] = []
    cb.onTrip((t) => seen.push(t.condition))
    cb.trip('drawdown_exceeded', 'x')
    cb.trip('consecutive_losses', 'y')
    expect(seen).toEqual(['drawdown_exceeded', 'consecutive_losses'])
  })

  it('a throwing listener does not prevent other listeners from being notified', () => {
    const cb = new CircuitBreaker()
    const good = vi.fn()
    cb.onTrip(() => {
      throw new Error('boom')
    })
    cb.onTrip(good)
    expect(() => cb.trip('price_oracle_disagreement', 'x')).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops further notifications', () => {
    const cb = new CircuitBreaker()
    const listener = vi.fn()
    const unsubscribe = cb.onTrip(listener)
    unsubscribe()
    cb.trip('reconciliation_mismatch', 'x')
    expect(listener).not.toHaveBeenCalled()
  })

  it('covers all nine named conditions without a typo (compile-time exhaustiveness via the type, runtime smoke test here)', () => {
    const cb = new CircuitBreaker()
    const all = [
      'rpc_unhealthy',
      'database_error',
      'sell_failure',
      'daily_loss_exceeded',
      'drawdown_exceeded',
      'consecutive_losses',
      'price_oracle_disagreement',
      'nonce_failure',
      'reconciliation_mismatch',
    ] as const
    for (const c of all) cb.trip(c, 'x')
    expect(cb.activeConditions()).toHaveLength(9)
  })
})
