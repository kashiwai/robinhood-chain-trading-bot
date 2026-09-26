import { describe, expect, it } from 'vitest'
import { loadFleetConfig, loadTelegramConfig } from '../../src/framework/config.js'

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

describe('loadFleetConfig — Level 10.1 runPhase (data separation only, never trading logic)', () => {
  it('defaults to "paper" in paper mode with no HOOD_RUN_PHASE set', () => {
    expect(loadFleetConfig(env()).runPhase).toBe('paper')
  })

  it('defaults to "live" in live mode with no HOOD_RUN_PHASE set', () => {
    const cfg = loadFleetConfig(
      env({ HOOD_TRADERS_LIVE: '1', ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY, LIVE_ACKNOWLEDGED: 'YES' }),
    )
    expect(cfg.runPhase).toBe('live')
  })

  it('HOOD_RUN_PHASE=shadow is respected in paper mode', () => {
    expect(loadFleetConfig(env({ HOOD_RUN_PHASE: 'shadow' })).runPhase).toBe('shadow')
  })

  it('HOOD_RUN_PHASE=probe is respected in live mode', () => {
    const cfg = loadFleetConfig(
      env({
        HOOD_TRADERS_LIVE: '1',
        ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY,
        LIVE_ACKNOWLEDGED: 'YES',
        HOOD_RUN_PHASE: 'probe',
      }),
    )
    expect(cfg.runPhase).toBe('probe')
  })

  it('an unrecognized HOOD_RUN_PHASE value throws', () => {
    expect(() => loadFleetConfig(env({ HOOD_RUN_PHASE: 'bogus' }))).toThrow()
  })

  it('HOOD_RUN_PHASE=live requested but live mode conditions are NOT met throws (misconfiguration, not a silent downgrade)', () => {
    expect(() => loadFleetConfig(env({ HOOD_RUN_PHASE: 'live' }))).toThrow()
  })

  it('HOOD_RUN_PHASE=probe requested but live mode conditions are NOT met throws', () => {
    expect(() => loadFleetConfig(env({ HOOD_RUN_PHASE: 'probe' }))).toThrow()
  })

  it('dbPath is scoped under a runPhase subdirectory — shadow and paper phases never share a DB', () => {
    const shadowCfg = loadFleetConfig(
      env({ HOOD_TRADERS_DB: './data/hood-traders.db', HOOD_RUN_PHASE: 'shadow' }),
    )
    const paperCfg = loadFleetConfig(
      env({ HOOD_TRADERS_DB: './data/hood-traders.db', HOOD_RUN_PHASE: 'paper' }),
    )
    expect(shadowCfg.dbPath).toBe('data/shadow/hood-traders.db')
    expect(paperCfg.dbPath).toBe('data/paper/hood-traders.db')
    expect(shadowCfg.dbPath).not.toBe(paperCfg.dbPath)
  })

  it('dbPath of ":memory:" is passed through unscoped (the test/in-memory sentinel)', () => {
    const cfg = loadFleetConfig(env({ HOOD_TRADERS_DB: ':memory:', HOOD_RUN_PHASE: 'shadow' }))
    expect(cfg.dbPath).toBe(':memory:')
  })

  it('HOOD_RUN_PHASE=paper requested while ALSO in live mode throws (paper phase must not run with real money armed)', () => {
    expect(() =>
      loadFleetConfig(
        env({
          HOOD_TRADERS_LIVE: '1',
          ROBINHOOD_CHAIN_PRIVATE_KEY: VALID_KEY,
          LIVE_ACKNOWLEDGED: 'YES',
          HOOD_RUN_PHASE: 'paper',
        }),
      ),
    ).toThrow()
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

describe('loadTelegramConfig — optional, but both-or-neither', () => {
  it('neither var set -> null (Telegram disabled)', () => {
    expect(loadTelegramConfig(env())).toBeNull()
  })

  it('both vars set -> a config', () => {
    const cfg = loadTelegramConfig(env({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '12345' }))
    expect(cfg).toEqual({ botToken: 'tok', chatId: '12345' })
  })

  it('only TELEGRAM_BOT_TOKEN set -> throws (a misconfiguration, not a silent partial-enable)', () => {
    expect(() => loadTelegramConfig(env({ TELEGRAM_BOT_TOKEN: 'tok' }))).toThrow()
  })

  it('only TELEGRAM_CHAT_ID set -> throws', () => {
    expect(() => loadTelegramConfig(env({ TELEGRAM_CHAT_ID: '12345' }))).toThrow()
  })
})
