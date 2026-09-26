/** The spec's fixed critical-alert vocabulary — nothing else is ever sent, and every one of these is a fire-and-forget notification, never a request for a decision. */
export type TelegramAlertType =
  | 'BOT_START'
  | 'BOT_STOP'
  | 'LIVE_GATE_REJECTED'
  | 'PROBE_START'
  | 'PROBE_PASS'
  | 'PROBE_FAIL'
  | 'REAL_BUY'
  | 'REAL_SELL'
  | 'EMERGENCY_EXIT'
  | 'SELL_FAILURE'
  | 'CIRCUIT_BREAKER'
  | 'DAILY_LOSS_LIMIT'
  | 'DRAWDOWN_LIMIT'
  | 'RPC_PRIMARY_DOWN'
  | 'ALL_RPC_DOWN'
  | 'DB_FAILURE'
  | 'RECONCILIATION_FAILURE'
  | 'KILL_SWITCH'

export type TelegramSendFn = (botToken: string, chatId: string, text: string) => Promise<void>

export interface TelegramAlerterOptions {
  botToken: string
  /** The spec's fixed, explicitly-configured admin chat — never learned from an incoming message ("first sender becomes admin" is exactly what this avoids). */
  chatId: string
  /** Injectable transport — tests supply a fake here instead of hitting the real Telegram API. Defaults to a real `fetch` call to api.telegram.org. */
  sendFn?: TelegramSendFn
  onError?: (error: Error) => void
}

/**
 * Send-only critical alerting. Structurally cannot trigger a trade: this
 * class has no method that accepts an order, a token, or an amount to buy —
 * it only ever sends a pre-formatted string outward. Failures here are
 * swallowed (logged via `onError`, never thrown) because a Telegram outage
 * must never be able to stall or crash the trading loop that called it.
 */
export class TelegramAlerter {
  constructor(private readonly opts: TelegramAlerterOptions) {}

  async send(type: TelegramAlertType, message: string): Promise<void> {
    const text = `[${type}] ${message}`
    const sendFn = this.opts.sendFn ?? defaultTelegramSend
    try {
      await sendFn(this.opts.botToken, this.opts.chatId, text)
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

async function defaultTelegramSend(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) throw new Error(`telegram sendMessage -> HTTP ${res.status}`)
}
