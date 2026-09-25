import { describe, expect, it } from 'vitest'
import { loadFleetConfig } from '../../src/framework/config.js'

const VALID_KEY = `0x${'1'.repeat(64)}`

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides }
}

describe('loadFleetConfig — dashboard bind address defaults to loopback-only', () => {
  it('no DASHBOARD_HOST set -> 127.0.0.1, never 0.0.0.0 by accident', () => {
    const cfg = loadFleetConfig(env())
    expect(cfg.dashboardHost).toBe('127.0.0.1')
  })

  it('DASHBOARD_HOST is respected when explicitly set (e.g. inside Docker)', () => {
    const cfg = loadFleetConfig(env({ DASHBOARD_HOST: '0.0.0.0' }))
    expect(cfg.dashboardHost).toBe('0.0.0.0')
  })
})

describe('loadFleetConfig — live mode requires ALL of HOOD_TRADERS_LIVE, a valid key, and LIVE_ACKNOWLEDGED=YES', () => {
  it('no env at all -> paper mode, no wallet', () => {
    const cfg = loadFleetConfig(env())
    expect(cfg.mode).toBe('paper')
    expect(cfg.hasWallet).toBe(false)
    expect(cfg.liveAcknowledged).toBe(false)
  })

  it('HOOD_TRADERS_LIVE=1 alone (no key, no ack) -> stays paper', () => {
    const cfg = loadFleetConfig(env({ HOOD_TRADERS_LIVE: '1' }))
    expect(cfg.mode).toBe('paper')
  })

  it('HOOD_TRADERS_LIVE=1 + valid key but WITHOUT LIVE_ACKNOWLEDGED=YES -> stays paper', () => {
    const cfg = loadFleetConfig(env({ HOOD_TRADERS_LIVE: '1', ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY }))
    expect(cfg.mode).toBe('paper')
    expect(cfg.hasWallet).toBe(true)
    expect(cfg.liveAcknowledged).toBe(false)
  })

  it('LIVE_ACKNOWLEDGED set to something other than the exact string "YES" -> stays paper', () => {
    const cfg = loadFleetConfig(
      env({
        HOOD_TRADERS_LIVE: '1',
        ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY,
        LIVE_ACKNOWLEDGED: 'yes', // lowercase — deliberately rejected, this is a consent string not a boolean flag
      }),
    )
    expect(cfg.mode).toBe('paper')
  })

  it('LIVE_ACKNOWLEDGED=YES alone, without HOOD_TRADERS_LIVE, -> stays paper', () => {
    const cfg = loadFleetConfig(env({ ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY, LIVE_ACKNOWLEDGED: 'YES' }))
    expect(cfg.mode).toBe('paper')
  })

  it('an invalid/malformed private key blocks live mode even with every other flag correct', () => {
    const cfg = loadFleetConfig(
      env({
        HOOD_TRADERS_LIVE: '1',
        ROBINHOOD_CHAIN_PRIVATE_KEY: '0xnotahexkey',
        LIVE_ACKNOWLEDGED: 'YES',
      }),
    )
    expect(cfg.mode).toBe('paper')
    expect(cfg.hasWallet).toBe(false)
  })

  it('ALL three conditions true simultaneously -> live mode', () => {
    const cfg = loadFleetConfig(
      env({
        HOOD_TRADERS_LIVE: '1',
        ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY,
        LIVE_ACKNOWLEDGED: 'YES',
      }),
    )
    expect(cfg.mode).toBe('live')
    expect(cfg.hasWallet).toBe(true)
    expect(cfg.liveAcknowledged).toBe(true)
    expect(cfg.privateKey).toBe(VALID_KEY)
  })
})
