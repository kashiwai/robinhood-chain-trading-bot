import type { AgentStatus } from '../framework/types.js'
import type { FleetSummary } from '../framework/fleet.js'

export interface TelegramUpdate {
  update_id: number
  message?: {
    chat: { id: number | string }
    text?: string
  }
}

export interface TelegramCommandContext {
  /** The spec's fixed, explicitly-configured admin chat — the ONLY chat a command is ever acted on for. */
  adminChatId: string
  fleetSummary: () => FleetSummary
  agentStatuses: () => AgentStatus[]
  /** Blocks new BUYs fleet-wide (see risk/circuit-breaker.ts's buyPaused). Never touches sells, never touches an existing position. */
  pause: () => void
}

export type TelegramCommandAction = 'none' | 'paused' | 'ignored_non_admin' | 'resume_forbidden'

export interface TelegramCommandResult {
  /** Empty for `ignored_non_admin` — a non-admin chat gets no reply at all, not even an error, so it can't even confirm a bot is listening. */
  reply: string
  action: TelegramCommandAction
}

const ALLOWED_COMMANDS = ['/status', '/positions', '/pause', '/resume'] as const

/**
 * Pure command dispatch — no network IO, so every branch is directly
 * unit-testable. `/resume` is deliberately, permanently forbidden (the
 * spec's "禁止または強認証必須" — this codebase chooses 禁止: no code path
 * anywhere clears a circuit breaker or the kill switch from Telegram).
 * There is no command, and can never accidentally be one, that reaches
 * Executor/Agent's buy path — the return type itself only ever names
 * 'paused' as a side effect, and `pause()` is typed to a void breaker call,
 * not an order.
 */
export function handleTelegramUpdate(
  update: TelegramUpdate,
  ctx: TelegramCommandContext,
): TelegramCommandResult | null {
  const message = update.message
  if (!message?.text) return null

  const chatId = String(message.chat.id)
  if (chatId !== ctx.adminChatId) {
    return { reply: '', action: 'ignored_non_admin' }
  }

  const text = message.text.trim()
  if (text === '/status') {
    const s = ctx.fleetSummary()
    return {
      reply:
        `mode=${s.mode} killed=${s.killed}${s.killReason ? `(${s.killReason})` : ''} ` +
        `equity=$${s.equityUsd.toFixed(2)} realized=$${s.realizedUsd.toFixed(2)} open=$${s.openValueUsd.toFixed(2)} ` +
        `spent=$${s.fleetSpentTodayUsd.toFixed(2)}/$${s.fleetMaxDailySpendUsdg} agents=${s.agents}`,
      action: 'none',
    }
  }
  if (text === '/positions') {
    const lines = ctx
      .agentStatuses()
      .flatMap((a) =>
        a.positions.map(
          (p) =>
            `${a.id}: ${p.tokenSymbol} invested=$${p.investedUsd.toFixed(2)} mark=${p.markUsd === null ? 'n/a' : `$${p.markUsd.toFixed(2)}`}`,
        ),
      )
    return { reply: lines.length > 0 ? lines.join('\n') : 'no open positions', action: 'none' }
  }
  if (text === '/pause') {
    ctx.pause()
    return {
      reply:
        'paused — new BUYs are blocked fleet-wide (sells and existing positions are unaffected). Resume is not available via Telegram; use the dashboard or restart the process.',
      action: 'paused',
    }
  }
  if (text === '/resume') {
    return {
      reply: 'resume via Telegram is disabled by design — use the dashboard or restart the process.',
      action: 'resume_forbidden',
    }
  }
  return {
    reply: `unrecognized command "${text}" — allowed: ${ALLOWED_COMMANDS.join(', ')}`,
    action: 'none',
  }
}
