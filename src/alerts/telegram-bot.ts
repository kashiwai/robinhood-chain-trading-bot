import {
  handleTelegramUpdate,
  type TelegramCommandContext,
  type TelegramUpdate,
} from './telegram-commands.js'
import type { TelegramSendFn } from './telegram.js'

export interface TelegramBotOptions {
  botToken: string
  pollIntervalMs?: number
  fetchUpdates?: (botToken: string, offset: number) => Promise<TelegramUpdate[]>
  sendFn?: TelegramSendFn
  onError?: (error: Error) => void
}

/**
 * Thin long-polling loop around the pure `handleTelegramUpdate` (see
 * telegram-commands.ts, where all the actually-interesting logic — and all
 * of its tests — live). This class exists only to fetch updates and post
 * replies; it deliberately contains no command logic of its own so there is
 * exactly one place ("admin chat only", "/resume forbidden", "no buy path")
 * that could ever need auditing for a safety regression.
 */
export class TelegramBot {
  private timer: ReturnType<typeof setInterval> | null = null
  private offset = 0

  constructor(
    private readonly opts: TelegramBotOptions,
    private readonly ctx: TelegramCommandContext,
  ) {}

  start(): void {
    if (this.timer) return
    const intervalMs = this.opts.pollIntervalMs ?? 3000
    this.timer = setInterval(() => void this.poll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    try {
      const fetchUpdates = this.opts.fetchUpdates ?? defaultFetchUpdates
      const updates = await fetchUpdates(this.opts.botToken, this.offset)
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1)
        const result = handleTelegramUpdate(update, this.ctx)
        if (!result || result.reply === '') continue
        const chatId = String(update.message!.chat.id)
        const sendFn = this.opts.sendFn ?? defaultSend
        await sendFn(this.opts.botToken, chatId, result.reply)
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

async function defaultFetchUpdates(botToken: string, offset: number): Promise<TelegramUpdate[]> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=0`)
  if (!res.ok) throw new Error(`telegram getUpdates -> HTTP ${res.status}`)
  const body = (await res.json()) as { result: TelegramUpdate[] }
  return body.result
}

async function defaultSend(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) throw new Error(`telegram sendMessage -> HTTP ${res.status}`)
}
