import { describe, expect, it, vi } from 'vitest'
import { TelegramAlerter } from '../../src/alerts/telegram.js'

describe('TelegramAlerter — send-only, structurally incapable of triggering a trade', () => {
  it('sends every message through the injected test transport, prefixed with the alert type', async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined)
    const alerter = new TelegramAlerter({ botToken: 'tok', chatId: '12345', sendFn })

    await alerter.send('KILL_SWITCH', 'kill file detected')

    expect(sendFn).toHaveBeenCalledWith('tok', '12345', '[KILL_SWITCH] kill file detected')
  })

  it('every one of the spec-named alert types is a valid, sendable type', async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined)
    const alerter = new TelegramAlerter({ botToken: 'tok', chatId: '1', sendFn })
    const types = [
      'BOT_START',
      'BOT_STOP',
      'LIVE_GATE_REJECTED',
      'PROBE_START',
      'PROBE_PASS',
      'PROBE_FAIL',
      'REAL_BUY',
      'REAL_SELL',
      'EMERGENCY_EXIT',
      'SELL_FAILURE',
      'CIRCUIT_BREAKER',
      'DAILY_LOSS_LIMIT',
      'DRAWDOWN_LIMIT',
      'RPC_PRIMARY_DOWN',
      'ALL_RPC_DOWN',
      'DB_FAILURE',
      'RECONCILIATION_FAILURE',
      'KILL_SWITCH',
    ] as const
    for (const t of types) await alerter.send(t, 'x')
    expect(sendFn).toHaveBeenCalledTimes(types.length)
  })

  it('a transport failure is swallowed (reported via onError) and never thrown — a Telegram outage must not crash the trading loop', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('network down'))
    const onError = vi.fn()
    const alerter = new TelegramAlerter({ botToken: 'tok', chatId: '1', sendFn, onError })

    await expect(alerter.send('BOT_START', 'hi')).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('has no method surface for constructing or submitting an order — send() takes only a fixed type and a string', () => {
    const alerter = new TelegramAlerter({ botToken: 'tok', chatId: '1', sendFn: vi.fn() })
    const proto = Object.getPrototypeOf(alerter) as object
    const methodNames = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor')
    expect(methodNames).toEqual(['send'])
  })
})
