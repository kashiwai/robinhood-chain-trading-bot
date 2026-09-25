import type { Address } from 'viem'
import type { ProbeEngine } from './probe.js'
import type { ProbeStore } from './probe-store.js'

export interface ProbeGateCheckInput {
  quoteToken: Address
  quoteTokenUsdPrice: number
  quoteDecimals: number
  slippageBps: number
}

export type ProbeGateAction = 'already_passed' | 'blacklisted' | 'probed'

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
 * `already_passed` once {@link ProbeStore.hasPassed} is true. A failed probe
 * blacklists the token, so `action: 'blacklisted'` covers both a
 * previously-failed probe and one that just failed right now.
 */
export class ProbeGate {
  constructor(
    private readonly probeEngine: Pick<ProbeEngine, 'runProbe'>,
    private readonly probeStore: Pick<ProbeStore, 'isBlacklisted' | 'hasPassed'>,
  ) {}

  async check(token: Address, input: ProbeGateCheckInput): Promise<ProbeGateResult> {
    if (this.probeStore.isBlacklisted(token)) {
      return { action: 'blacklisted', reason: 'token blacklisted from a prior failed probe' }
    }
    if (this.probeStore.hasPassed(token)) {
      return { action: 'already_passed', reason: 'probe already passed' }
    }
    const result = await this.probeEngine.runProbe({ token, ...input })
    return result.passed
      ? { action: 'probed', reason: result.reason }
      : { action: 'blacklisted', reason: result.reason }
  }
}
