import { afterEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { ProbeStore } from '../../src/execution/probe-store.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address

describe('ProbeStore — Level 10.1 failure-class-aware blacklist/quarantine', () => {
  let store: ProbeStore
  afterEach(() => store?.close())

  it('a PERMANENT_TOKEN_FAILURE blacklists and is never quarantined', () => {
    store = new ProbeStore(':memory:')
    store.record({
      token: TOKEN,
      passed: false,
      reason: 'honeypot',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts: Date.now(),
      failureClass: 'PERMANENT_TOKEN_FAILURE',
    })
    expect(store.isBlacklisted(TOKEN)).toBe(true)
    expect(store.isQuarantined(TOKEN, Date.now(), 30 * 60_000)).toBe(false)
  })

  it('a TEMPORARY_INFRA_FAILURE quarantines but never blacklists', () => {
    store = new ProbeStore(':memory:')
    const ts = Date.now()
    store.record({
      token: TOKEN,
      passed: false,
      reason: 'receipt wait timed out',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts,
      failureClass: 'TEMPORARY_INFRA_FAILURE',
    })
    expect(store.isBlacklisted(TOKEN)).toBe(false)
    expect(store.isQuarantined(TOKEN, ts + 1000, 30 * 60_000)).toBe(true)
  })

  it('a MARKET_FAILURE quarantines but never blacklists', () => {
    store = new ProbeStore(':memory:')
    const ts = Date.now()
    store.record({
      token: TOKEN,
      passed: false,
      reason: 'no buy route at probe size',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts,
      failureClass: 'MARKET_FAILURE',
    })
    expect(store.isBlacklisted(TOKEN)).toBe(false)
    expect(store.isQuarantined(TOKEN, ts + 1000, 30 * 60_000)).toBe(true)
  })

  it('a quarantine clears once the cooldown elapses — the token becomes eligible for a retry', () => {
    store = new ProbeStore(':memory:')
    const ts = Date.now()
    store.record({
      token: TOKEN,
      passed: false,
      reason: 'RPC 429',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts,
      failureClass: 'TEMPORARY_INFRA_FAILURE',
    })
    expect(store.isQuarantined(TOKEN, ts + 30 * 60_000 - 1, 30 * 60_000)).toBe(true)
    expect(store.isQuarantined(TOKEN, ts + 30 * 60_000 + 1, 30 * 60_000)).toBe(false)
  })

  it('retryCount increments across repeated infra/market failures, but never for a permanent one', () => {
    store = new ProbeStore(':memory:')
    const record = (failureClass: 'TEMPORARY_INFRA_FAILURE' | 'PERMANENT_TOKEN_FAILURE', ts: number) =>
      store.record({
        token: TOKEN,
        passed: false,
        reason: 'x',
        measuredBuyTaxBps: null,
        measuredSellTaxBps: null,
        ts,
        failureClass,
      })

    record('TEMPORARY_INFRA_FAILURE', 1)
    expect(store.get(TOKEN)?.retryCount).toBe(1)
    record('TEMPORARY_INFRA_FAILURE', 2)
    expect(store.get(TOKEN)?.retryCount).toBe(2)
    record('PERMANENT_TOKEN_FAILURE', 3)
    expect(store.get(TOKEN)?.retryCount).toBe(2) // a permanent failure doesn't add another retry — there's no more retrying
    expect(store.isBlacklisted(TOKEN)).toBe(true)
  })

  it('a subsequent PASS resets retryCount to zero and clears any quarantine/blacklist reading', () => {
    store = new ProbeStore(':memory:')
    store.record({
      token: TOKEN,
      passed: false,
      reason: 'RPC 429',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts: 1,
      failureClass: 'TEMPORARY_INFRA_FAILURE',
    })
    store.record({
      token: TOKEN,
      passed: true,
      reason: 'probe passed',
      measuredBuyTaxBps: 10,
      measuredSellTaxBps: 10,
      ts: 2,
    })
    expect(store.hasPassed(TOKEN)).toBe(true)
    expect(store.isBlacklisted(TOKEN)).toBe(false)
    expect(store.isQuarantined(TOKEN, 3, 30 * 60_000)).toBe(false)
    expect(store.get(TOKEN)?.retryCount).toBe(0)
  })

  it('a never-probed token is neither blacklisted nor quarantined', () => {
    store = new ProbeStore(':memory:')
    expect(store.isBlacklisted(TOKEN)).toBe(false)
    expect(store.isQuarantined(TOKEN, Date.now(), 30 * 60_000)).toBe(false)
  })
})
