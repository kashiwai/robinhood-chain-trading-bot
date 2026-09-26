import { describe, expect, it, vi } from 'vitest'
import {
  handleTelegramUpdate,
  type TelegramCommandContext,
  type TelegramUpdate,
} from '../../src/alerts/telegram-commands.js'
import type { FleetSummary } from '../../src/framework/fleet.js'
import type { AgentStatus } from '../../src/framework/types.js'

const ADMIN_CHAT_ID = '111111'

function fleetSummary(overrides: Partial<FleetSummary> = {}): FleetSummary {
  return {
    network: 'mainnet',
    mode: 'paper',
    killed: false,
    killReason: null,
    fleetSpentTodayUsd: 10,
    fleetMaxDailySpendUsdg: 250,
    realizedUsd: 5,
    openValueUsd: 20,
    equityUsd: 25,
    agents: 3,
    startedAt: 0,
    ...overrides,
  }
}

function ctx(overrides: Partial<TelegramCommandContext> = {}): TelegramCommandContext {
  return {
    adminChatId: ADMIN_CHAT_ID,
    fleetSummary: () => fleetSummary(),
    agentStatuses: () => [],
    pause: vi.fn(),
    ...overrides,
  }
}

function textUpdate(chatId: string | number, text: string): TelegramUpdate {
  return { update_id: 1, message: { chat: { id: chatId }, text } }
}

describe('handleTelegramUpdate — pure command dispatch, no network IO', () => {
  it('a message from a non-admin chat is ignored — no reply, no action, regardless of the command text', () => {
    const result = handleTelegramUpdate(textUpdate('999999', '/status'), ctx())
    expect(result).toEqual({ reply: '', action: 'ignored_non_admin' })
  })

  it('an update with no message text returns null (nothing to act on)', () => {
    expect(handleTelegramUpdate({ update_id: 1 }, ctx())).toBeNull()
  })

  it('/status from the admin chat replies with a real fleet summary', () => {
    const result = handleTelegramUpdate(
      textUpdate(ADMIN_CHAT_ID, '/status'),
      ctx({ fleetSummary: () => fleetSummary({ mode: 'live', killed: true, killReason: 'kill_file' }) }),
    )
    expect(result?.action).toBe('none')
    expect(result?.reply).toContain('mode=live')
    expect(result?.reply).toContain('killed=true')
    expect(result?.reply).toContain('kill_file')
  })

  it('/positions from the admin chat lists every open position across every agent', () => {
    const statuses: AgentStatus[] = [
      {
        id: 'sniper-1',
        strategy: 'launch-sniper',
        mode: 'paper',
        running: true,
        killed: false,
        limits: { maxPositionUsdg: 50, maxDailySpendUsdg: 100, maxSlippageBps: 100, cooldownSeconds: 60 },
        spentTodayUsd: 0,
        realizedUsd: 0,
        openValueUsd: 12,
        equityUsd: 12,
        positions: [
          {
            token: '0x1111111111111111111111111111111111111a',
            tokenSymbol: 'MEME',
            amount: 100n,
            costBasis: 10n,
            investedUsd: 10,
            quoteToken: '0x2222222222222222222222222222222222222b',
            quoteSymbol: 'WETH',
            openedAt: 0,
            markUsd: 12,
            meta: {},
          },
        ],
        lastTickAt: 0,
        lastError: null,
        ticks: 1,
        trades: 1,
        refusals: 0,
      },
    ]
    const result = handleTelegramUpdate(
      textUpdate(ADMIN_CHAT_ID, '/positions'),
      ctx({ agentStatuses: () => statuses }),
    )
    expect(result?.reply).toContain('sniper-1: MEME')
    expect(result?.reply).toContain('mark=$12.00')
  })

  it('/positions with nothing open says so explicitly', () => {
    const result = handleTelegramUpdate(
      textUpdate(ADMIN_CHAT_ID, '/positions'),
      ctx({ agentStatuses: () => [] }),
    )
    expect(result?.reply).toBe('no open positions')
  })

  it('/pause calls ctx.pause() exactly once and confirms in the reply — never anything buy/sell related', () => {
    const pause = vi.fn()
    const result = handleTelegramUpdate(textUpdate(ADMIN_CHAT_ID, '/pause'), ctx({ pause }))
    expect(pause).toHaveBeenCalledTimes(1)
    expect(result?.action).toBe('paused')
    expect(result?.reply).toMatch(/paused/i)
  })

  it('/resume is forbidden — no code path clears anything, regardless of chat', () => {
    const pause = vi.fn()
    const result = handleTelegramUpdate(textUpdate(ADMIN_CHAT_ID, '/resume'), ctx({ pause }))
    expect(result?.action).toBe('resume_forbidden')
    expect(pause).not.toHaveBeenCalled()
  })

  it('an unrecognized command replies with the allowed list, and never invokes pause()', () => {
    const pause = vi.fn()
    const result = handleTelegramUpdate(textUpdate(ADMIN_CHAT_ID, '/buy MEME 1000'), ctx({ pause }))
    expect(result?.action).toBe('none')
    expect(result?.reply).toContain('unrecognized command')
    expect(pause).not.toHaveBeenCalled()
  })

  it('there is no command string, from any chat, that results in an action other than none/paused/resume_forbidden/ignored_non_admin', () => {
    const pause = vi.fn()
    const commands = ['/status', '/positions', '/pause', '/resume', '/buy', '/sell', '/withdraw', 'anything']
    const validActions = new Set(['none', 'paused', 'resume_forbidden', 'ignored_non_admin'])
    for (const cmd of commands) {
      for (const chatId of [ADMIN_CHAT_ID, '999999']) {
        const result = handleTelegramUpdate(textUpdate(chatId, cmd), ctx({ pause }))
        expect(validActions.has(result!.action)).toBe(true)
      }
    }
  })
})
