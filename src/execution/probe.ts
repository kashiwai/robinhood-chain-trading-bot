import { parseUnits, type Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { Executor } from './executor.js'
import { ProbeStore } from './probe-store.js'
import { classifyProbeFailure, type ProbeFailureClass } from './probe-failure.js'

export interface ProbeConfig {
  /** USD size of the probe buy. @defaultValue 2 */
  probeBuyUsd: number
  /** Fraction of the actual probe fill to sell back. @defaultValue 0.5 */
  probeSellFraction: number
  /** How long a TEMPORARY_INFRA_FAILURE/MARKET_FAILURE token stays quarantined before a retry is allowed (see probe-store.ts's isQuarantined). @defaultValue 1800000 (30 min) */
  quarantineCooldownMs: number
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  probeBuyUsd: 2,
  probeSellFraction: 0.5,
  quarantineCooldownMs: 30 * 60_000,
}

export interface ProbeEngineOptions {
  executor: Pick<Executor, 'execute'>
  market: Pick<Market, 'quoteBuy' | 'quoteSell'>
  probeStore: ProbeStore
  agentId: string
  config?: Partial<ProbeConfig>
}

export interface RunProbeInput {
  token: Address
  quoteToken: Address
  /** USD value of one whole quote-token unit (1.0 for USDG, live ETH/USD for WETH). */
  quoteTokenUsdPrice: number
  quoteDecimals: number
  slippageBps: number
}

export interface ProbeResult {
  token: Address
  passed: boolean
  reason: string
  measuredBuyTaxBps: number | null
  measuredSellTaxBps: number | null
  /** null when `passed`; otherwise the Level 10.1 classification (see execution/probe-failure.ts) — only PERMANENT_TOKEN_FAILURE blacklists. */
  failureClass: ProbeFailureClass | null
}

/**
 * The spec's probe flow, run against REAL money via the Level 6 {@link
 * Executor} — not a simulation. A token that passed every upstream
 * simulation (Level 5's sellability/liquidity/contract checks) still gets a
 * real $2 buy and a real 50%-of-actual sell before a main-size order is ever
 * eligible: `candidate -> simulation PASS -> $2 buy -> actual balance check
 * -> 50% sell -> sell success -> tax/slippage measurement -> main order
 * eligibility`. Any failure blacklists the token permanently (see
 * probe-store.ts) — "新規本注文禁止". A previously-passed or
 * previously-blacklisted token short-circuits immediately without spending
 * anything a second time.
 */
export class ProbeEngine {
  private readonly config: ProbeConfig
  private readonly probeStore: ProbeStore

  constructor(private readonly opts: ProbeEngineOptions) {
    this.config = { ...DEFAULT_PROBE_CONFIG, ...opts.config }
    this.probeStore = opts.probeStore
  }

  async runProbe(input: RunProbeInput, now = Date.now()): Promise<ProbeResult> {
    if (this.probeStore.isBlacklisted(input.token)) {
      return this.result(
        input.token,
        false,
        'blacklisted from a prior failed probe',
        null,
        null,
        'PERMANENT_TOKEN_FAILURE',
      )
    }
    if (this.probeStore.hasPassed(input.token)) {
      return this.result(input.token, true, 'already probe-passed', null, null, null)
    }
    if (this.probeStore.isQuarantined(input.token, now, this.config.quarantineCooldownMs)) {
      return this.result(
        input.token,
        false,
        'quarantined from a prior temporary/market failure — cooldown has not elapsed yet',
        null,
        null,
        this.probeStore.get(input.token)?.failureClass ?? null,
      )
    }

    const probeTokenAmount = this.config.probeBuyUsd / input.quoteTokenUsdPrice
    const probeAmountIn = parseUnits(
      probeTokenAmount.toFixed(Math.min(input.quoteDecimals, 18)),
      input.quoteDecimals,
    )

    const buyQuote = await this.opts.market.quoteBuy(input.quoteToken, input.token, probeAmountIn)
    if (!buyQuote || buyQuote.amountOut <= 0n) {
      return this.fail(input.token, 'no buy route at probe size')
    }

    const buyOrder = await this.opts.executor.execute({
      idempotencyKey: `probe-buy:${input.token.toLowerCase()}`,
      agentId: this.opts.agentId,
      token: input.token,
      quoteToken: input.quoteToken,
      side: 'buy',
      amountIn: probeAmountIn,
      quote: buyQuote,
      slippageBps: input.slippageBps,
    })
    if (!isSuccess(buyOrder.state) || !buyOrder.actualAmountOut || buyOrder.actualAmountOut <= 0n) {
      return this.fail(input.token, `probe buy failed: ${buyOrder.error ?? buyOrder.state}`)
    }

    const sellFractionBps = BigInt(Math.round(this.config.probeSellFraction * 10_000))
    const sellAmount = (buyOrder.actualAmountOut * sellFractionBps) / 10_000n

    const sellQuote = await this.opts.market.quoteSell(input.token, input.quoteToken, sellAmount)
    if (!sellQuote || sellQuote.amountOut <= 0n) {
      return this.fail(
        input.token,
        'probe sell quote failed — cannot sell back despite a clean buy (honeypot signature)',
      )
    }

    const sellOrder = await this.opts.executor.execute({
      idempotencyKey: `probe-sell:${input.token.toLowerCase()}`,
      agentId: this.opts.agentId,
      token: input.token,
      quoteToken: input.quoteToken,
      side: 'sell',
      amountIn: sellAmount,
      quote: sellQuote,
      slippageBps: input.slippageBps,
    })
    if (!isSuccess(sellOrder.state) || sellOrder.actualAmountOut === null) {
      return this.fail(input.token, `probe sell failed: ${sellOrder.error ?? sellOrder.state}`)
    }

    const measuredBuyTaxBps = taxBps(buyQuote.amountOut, buyOrder.actualAmountOut)
    const measuredSellTaxBps = taxBps(sellQuote.amountOut, sellOrder.actualAmountOut)

    const reason = `probe passed — buy tax ${bps(measuredBuyTaxBps)}, sell tax ${bps(measuredSellTaxBps)}`
    this.probeStore.record({
      token: input.token,
      passed: true,
      reason,
      measuredBuyTaxBps,
      measuredSellTaxBps,
      ts: Date.now(),
    })
    return {
      token: input.token,
      passed: true,
      reason,
      measuredBuyTaxBps,
      measuredSellTaxBps,
      failureClass: null,
    }
  }

  private fail(token: Address, reason: string): ProbeResult {
    const failureClass = classifyProbeFailure(reason)
    this.probeStore.record({
      token,
      passed: false,
      reason,
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts: Date.now(),
      failureClass,
    })
    return this.result(token, false, reason, null, null, failureClass)
  }

  private result(
    token: Address,
    passed: boolean,
    reason: string,
    measuredBuyTaxBps: number | null,
    measuredSellTaxBps: number | null,
    failureClass: ProbeFailureClass | null,
  ): ProbeResult {
    return { token, passed, reason, measuredBuyTaxBps, measuredSellTaxBps, failureClass }
  }
}

function isSuccess(state: string): boolean {
  return state === 'RECONCILED' || state === 'CONFIRMED' || state === 'MINED'
}

function taxBps(quoted: bigint, actual: bigint): number {
  if (quoted <= 0n) return 0
  return Number(((quoted - actual) * 10_000n) / quoted)
}

function bps(n: number): string {
  return `${(n / 100).toFixed(2)}%`
}

export { ProbeStore }
