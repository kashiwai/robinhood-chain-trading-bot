import type { Address } from 'viem'
import type { ProbeEngine } from './probe.js'
import type { ProbeStore } from './probe-store.js'
import type { TelegramAlerter } from '../alerts/telegram.js'

export interface ProbeGateCheckInput {
  quoteToken: Address
  quoteTokenUsdPrice: number
  quoteDecimals: number
  slippageBps: number
}

export type ProbeGateAction = 'already_passed' | 'blacklisted' | 'quarantined' | 'probed'

export interface ProbeGateResult {
  action: ProbeGateAction
  reason: string
}

/**
 * Wires the spec's "新規本注文禁止" rule into the live buy path: a token's
 * FIRST live buy is never the strategy's full-size order — it is always a
 * real $2 {@link ProbeEngine} round trip first. `action: 'probed'` means the
 * $2 probe itself just ran (and consumed this tick); the caller must refuse
 * the full-size buy this tick regardless of outcome and let a later tick see
 * `already_passed` once {@link ProbeStore.hasPassed} is true.
 *
 * Level 10.1: a failed probe no longer blanket-blacklists. `blacklisted`
 * means a genuine PERMANENT_TOKEN_FAILURE (honeypot, on-chain revert,
 * blacklist/tax restriction — see probe-failure.ts) — permanent, same as
 * before. `quarantined` means a TEMPORARY_INFRA_FAILURE or MARKET_FAILURE:
 * the token is refused for now but will become eligible for a fresh probe
 * once `ProbeStore`'s cooldown elapses, since an RPC timeout or a thin
 * order book at probe time proves nothing about the token itself.
 */
export class ProbeGate {
  constructor(
    private readonly probeEngine: Pick<ProbeEngine, 'runProbe'>,
    private readonly probeStore: Pick<ProbeStore, 'isBlacklisted' | 'hasPassed' | 'isQuarantined'>,
    private readonly quarantineCooldownMs = 30 * 60_000,
    private readonly telegramAlerter?: Pick<TelegramAlerter, 'send'>,
  ) {}

  async check(token: Address, input: ProbeGateCheckInput, now = Date.now()): Promise<ProbeGateResult> {
    if (this.probeStore.isBlacklisted(token)) {
      return { action: 'blacklisted', reason: 'token blacklisted from a prior PERMANENT_TOKEN_FAILURE probe' }
    }
    if (this.probeStore.hasPassed(token)) {
      return { action: 'already_passed', reason: 'probe already passed' }
    }
    if (this.probeStore.isQuarantined(token, now, this.quarantineCooldownMs)) {
      return {
        action: 'quarantined',
        reason: 'quarantined from a prior temporary/market failure — retry cooldown not yet elapsed',
      }
    }
    void this.telegramAlerter?.send('PROBE_START', `${token} — real $2 probe starting`)
    const result = await this.probeEngine.runProbe({ token, ...input }, now)
    if (result.passed) {
      void this.telegramAlerter?.send('PROBE_PASS', `${token}: ${result.reason}`)
      return { action: 'probed', reason: result.reason }
    }
    void this.telegramAlerter?.send('PROBE_FAIL', `${token} [${result.failureClass}]: ${result.reason}`)
    return result.failureClass === 'PERMANENT_TOKEN_FAILURE'
      ? { action: 'blacklisted', reason: result.reason }
      : { action: 'quarantined', reason: result.reason }
  }
}
