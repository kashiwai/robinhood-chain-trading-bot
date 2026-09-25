import { formatUnits, type Account, type Address, type Hash } from 'viem'
import { buildSwapTx, ensureApproval, type SwapQuote } from 'hoodchain'
import type { Journal } from './journal.js'
import type { Market } from './market.js'
import { RiskEngine, utcDayStart } from './risk.js'
import type { KillSwitch } from './kill.js'
import type { Strategy } from './strategy.js'
import type { AgentStatus, Decision, Intent, Mode, Position, RiskLimits, TradeRecord } from './types.js'
import type { Executor } from '../execution/executor.js'
import type { ProbeGate } from '../execution/probe-gate.js'
import type { CircuitBreaker } from '../risk/circuit-breaker.js'
import { checkAccountRisk, type AccountRiskContext } from '../risk/account-risk.js'
import type { AccountRiskProfile } from '../risk/risk-profile.js'

/** Everything an {@link Agent} is constructed with. */
export interface AgentOptions {
  id: string
  strategy: Strategy
  market: Market
  limits: RiskLimits
  journal: Journal
  kill: KillSwitch
  mode: Mode
  /** Account for live execution; null in paper mode. */
  account: Account | null
  fleetMaxDailySpendUsdg: number
  /** Fleet-wide spend accessor + reporter, so the agent respects the global cap. */
  fleetSpentTodayUsd: () => number
  reportFleetSpend: (usd: number) => void
  /** Milliseconds between decision ticks. */
  tickIntervalMs: number
  /** Injected clock, for tests. Defaults to `Date.now`. */
  clock?: () => number
  /**
   * Level 6 execution engine (order lifecycle + nonce management + fill
   * reconciliation — see src/execution/executor.ts). Optional and additive:
   * when absent, live mode falls back to the simple inline sign-and-submit
   * this class always had. main.ts wires a real one; unit tests (and any
   * mode !== 'live' run) never need to.
   */
  executor?: Executor
  /** Level 7: the spec's nine named breakers. When tripped, refuses every BUY (never sells) — see risk/circuit-breaker.ts. */
  circuitBreaker?: CircuitBreaker
  /** Level 7: the $1,000 account-wide risk profile, checked before every buy (see risk/account-risk.ts). Fleet supplies a live context snapshot per candidate. */
  accountRisk?: {
    profile: AccountRiskProfile
    contextProvider: (candidatePositionUsd: number) => AccountRiskContext
  }
  /** Reports a sell's realized PnL delta (+/-) back to the fleet, feeding its daily-loss/drawdown/consecutive-loss tracking. */
  reportTradeResult?: (pnlUsd: number) => void
  /** Level 10: gates every token's first live buy behind a real $2 probe (see execution/probe-gate.ts). Optional — absent in paper mode and in tests that don't exercise it. */
  probeGate?: ProbeGate
}

const DUST = 1_000n // token smallest-units below which a position is considered closed

interface LiveExecutionResult {
  hash: Hash
  /** Quoted floor (post-slippage) — always populated, the pre-Level-6 fallback figure. */
  amountOutMinimum: bigint
  /** Real reconciled fill (Level 6, Executor path only) — null on the plain inline-executeLive path. */
  actualAmountOut: bigint | null
}

/**
 * An autonomous trading agent = strategy + wallet + risk budget + journal.
 *
 * Each tick runs the full pipeline: observe (the strategy reads the {@link
 * Market}) → decide (the strategy returns intents) → simulate (a real QuoterV2
 * `eth_call`) → risk-check (the {@link RiskEngine}, fail-closed) → execute
 * (paper: record the simulated fill; live: sign the swap) → journal (every
 * decision, refusal, trade, and equity mark). The strategy proposes; the agent
 * disposes, and never lets an intent skip the risk gate.
 */
export class Agent {
  readonly id: string
  readonly strategy: Strategy
  readonly mode: Mode
  private readonly market: Market
  private readonly risk: RiskEngine
  private readonly journal: Journal
  private readonly kill: KillSwitch
  private readonly account: Account | null
  private readonly opts: AgentOptions
  private readonly clock: () => number

  private readonly positions = new Map<string, Position>()
  private lastTradeAt: number | null = null
  private realizedUsd = 0
  private spentTodayUsd = 0
  private spentDay = 0
  private ticks = 0
  private trades = 0
  private refusals = 0
  private lastTickAt: number | null = null
  private lastError: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private ticking = false

  constructor(opts: AgentOptions) {
    this.opts = opts
    this.id = opts.id
    this.strategy = opts.strategy
    this.mode = opts.mode
    this.market = opts.market
    this.risk = new RiskEngine(opts.limits)
    this.journal = opts.journal
    this.kill = opts.kill
    this.account = opts.account
    this.clock = opts.clock ?? Date.now
  }

  /** Begin the tick loop and wire the strategy's stream subscriptions. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const log = (message: string, meta: Record<string, unknown> = {}) =>
      this.journal.recordDecision({
        agentId: this.id,
        ts: this.clock(),
        kind: 'observe',
        detail: message,
        meta,
      })
    await this.strategy.start?.({ market: this.market, log })
    this.kill.onKill((reason) => log(`kill switch tripped: ${reason} — halting new orders`))
    this.scheduleTick()
  }

  /** Stop the loop and the strategy's subscriptions. */
  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.strategy.stop?.()
  }

  private scheduleTick(): void {
    if (!this.running) return
    this.timer = setTimeout(async () => {
      await this.tick()
      this.scheduleTick()
    }, this.opts.tickIntervalMs)
    this.timer.unref?.()
  }

  /** Run one full pipeline pass. Safe to call directly (used by tests). */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    const now = this.clock()
    try {
      this.rolloverDay(now)
      await this.markPositions(now)

      if (this.kill.isKilled()) {
        // Halted: still mark equity so the curve shows the freeze, but propose nothing.
        this.recordEquity(now)
        this.ticks++
        this.lastTickAt = now
        return
      }

      const decision = await this.decide(now)
      for (const alert of decision.alerts) {
        this.journal.recordDecision({
          agentId: this.id,
          ts: now,
          kind: 'alert',
          detail: `[${alert.level}] ${alert.message}`,
          meta: alert.meta ?? {},
        })
      }
      for (const intent of decision.intents) {
        await this.processIntent(intent, now)
      }

      this.recordEquity(now)
      this.ticks++
      this.lastTickAt = now
      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.journal.recordDecision({
        agentId: this.id,
        ts: now,
        kind: 'observe',
        detail: `tick error: ${this.lastError}`,
        meta: {},
      })
    } finally {
      this.ticking = false
    }
  }

  private async decide(now: number): Promise<Decision> {
    const { quoteToken, quoteSymbol, quoteDecimals } = this.quoteInfo()
    return this.strategy.tick({
      market: this.market,
      positions: [...this.positions.values()],
      now,
      quoteToken,
      quoteSymbol,
      quoteDecimals,
      log: (message, meta = {}) =>
        this.journal.recordDecision({ agentId: this.id, ts: now, kind: 'observe', detail: message, meta }),
    })
  }

  private quoteInfo(): { quoteToken: Address; quoteSymbol: string; quoteDecimals: number } {
    if (this.strategy.quote === 'weth') {
      return { quoteToken: this.market.weth, quoteSymbol: 'WETH', quoteDecimals: 18 }
    }
    return { quoteToken: this.market.usdg, quoteSymbol: 'USDG', quoteDecimals: this.market.usdgDecimals }
  }

  private async processIntent(intent: Intent, now: number): Promise<void> {
    const refuse = (reason: string, detail: string, meta: Record<string, unknown> = {}) => {
      this.refusals++
      this.journal.recordDecision({
        agentId: this.id,
        ts: now,
        kind: 'refused',
        detail: `${intent.side} ${intent.tokenSymbol}: ${detail}`,
        meta: { reason, intentReason: intent.reason, ...meta },
      })
    }

    const quoteToken = intent.quoteToken
    const quoteDecimals = intent.quoteSymbol === 'USDG' ? this.market.usdgDecimals : 18

    // ── simulate (real eth_call against live pools) ────────────────────────────
    let sim: SwapQuote | null
    if (intent.side === 'buy') {
      sim = await this.market.quoteBuy(quoteToken, intent.token, intent.amountIn)
    } else {
      sim = await this.market.quoteSell(intent.token, quoteToken, intent.amountIn)
    }
    if (!sim || sim.amountOut <= 0n) {
      refuse('no_route', 'no liquid route to simulate the fill')
      return
    }

    // ── notional in USD ────────────────────────────────────────────────────────
    const ethUsd = intent.quoteSymbol === 'WETH' ? await this.market.ethUsd(30_000, now) : 1
    if (ethUsd === null) {
      refuse('no_route', 'cannot price ETH to enforce USD caps')
      return
    }
    let notionalUsd: number
    if (intent.side === 'buy') {
      notionalUsd = Number(formatUnits(intent.amountIn, quoteDecimals)) * ethUsd
    } else {
      notionalUsd = Number(formatUnits(sim.amountOut, quoteDecimals)) * ethUsd
    }

    // ── position accounting for the cap ────────────────────────────────────────
    const existing = this.positions.get(intent.token.toLowerCase())
    if (intent.side === 'sell') {
      if (!existing || existing.amount < intent.amountIn - DUST) {
        refuse('insufficient_balance', 'position too small to sell requested amount')
        return
      }
    }
    const positionUsdAfter = intent.side === 'buy' ? (existing?.investedUsd ?? 0) + notionalUsd : 0

    // ── slippage bound ─────────────────────────────────────────────────────────
    const slippageBps = Math.min(intent.maxSlippageBps ?? this.risk.riskLimits.maxSlippageBps, 10_000)
    const minOut = (sim.amountOut * BigInt(10_000 - slippageBps)) / 10_000n

    // ── risk gate (fail closed) ────────────────────────────────────────────────
    const verdict = this.risk.check({
      side: intent.side,
      notionalUsd,
      positionUsdAfter,
      spentTodayUsd: this.spentTodayUsd,
      fleetSpentTodayUsd: this.opts.fleetSpentTodayUsd(),
      lastTradeAt: this.lastTradeAt,
      slippageBps,
      killed: this.kill.isKilled(),
      now,
      fleetMaxDailySpendUsdg: this.opts.fleetMaxDailySpendUsdg,
    })
    if (!verdict.ok) {
      refuse(verdict.reason ?? 'refused', verdict.detail, { notionalUsd: round(notionalUsd) })
      return
    }

    // ── Level 7: circuit breaker + account-wide risk (buys only — sells always pass, same principle as above) ──
    if (intent.side === 'buy') {
      if (this.opts.circuitBreaker?.buyPaused()) {
        const conditions = this.opts.circuitBreaker
          .activeConditions()
          .map((c) => c.condition)
          .join(', ')
        refuse('circuit_breaker', `BUY paused — active breaker(s): ${conditions}`, {
          notionalUsd: round(notionalUsd),
        })
        return
      }
      if (this.opts.accountRisk) {
        const accountVerdict = checkAccountRisk(
          this.opts.accountRisk.contextProvider(notionalUsd),
          this.opts.accountRisk.profile,
        )
        if (!accountVerdict.ok) {
          refuse(accountVerdict.reason ?? 'account_risk', accountVerdict.detail, {
            notionalUsd: round(notionalUsd),
          })
          return
        }
      }

      // ── Level 10: probe gate — a token's first-ever live buy is always a real $2 round trip first ──
      if (this.mode === 'live' && this.opts.probeGate && !existing) {
        const gate = await this.opts.probeGate.check(intent.token, {
          quoteToken,
          quoteTokenUsdPrice: ethUsd,
          quoteDecimals,
          slippageBps,
        })
        if (gate.action !== 'already_passed') {
          refuse(gate.action === 'blacklisted' ? 'probe_blacklisted' : 'probe_ran_this_tick', gate.reason, {
            notionalUsd: round(notionalUsd),
          })
          return
        }
      }
    }

    // ── execute ────────────────────────────────────────────────────────────────
    let txHash: Hash | null = null
    let amountOut = sim.amountOut
    if (this.mode === 'live') {
      const executed = this.opts.executor
        ? await this.executeLiveViaExecutor(this.opts.executor, intent, sim, slippageBps, now)
        : await this.executeLive(intent, sim, slippageBps)
      if (!executed) {
        refuse('no_route', 'live execution failed (see logs)')
        return
      }
      txHash = executed.hash
      // Real reconciled fill (Level 6) when available; otherwise the
      // conservative quoted floor (amountOutMinimum), as before.
      amountOut = executed.actualAmountOut ?? executed.amountOutMinimum
    }

    // ── journal + book-keeping ──────────────────────────────────────────────────
    const trade: TradeRecord = {
      agentId: this.id,
      mode: this.mode,
      ts: now,
      side: intent.side,
      token: intent.token,
      tokenSymbol: intent.tokenSymbol,
      quoteToken,
      quoteSymbol: intent.quoteSymbol,
      amountIn: intent.amountIn,
      amountOut,
      txHash,
      reason: intent.reason,
      slippageBps,
      gasEstimate: sim.gasEstimate,
      meta: { ...(intent.meta ?? {}), notionalUsd: round(notionalUsd), minOut: minOut.toString() },
    }
    this.journal.recordTrade(trade)
    this.trades++
    this.lastTradeAt = now
    const realizedPnlDelta = this.applyFill(intent, amountOut, notionalUsd, now)
    if (intent.side === 'buy') {
      this.spentTodayUsd += notionalUsd
      this.opts.reportFleetSpend(notionalUsd)
    } else if (realizedPnlDelta !== null) {
      this.opts.reportTradeResult?.(realizedPnlDelta)
    }
  }

  /**
   * Level 6 path (an {@link Executor} was supplied): full lifecycle tracking,
   * nonce management, and real fill reconciliation (see
   * src/execution/executor.ts). Idempotency key comes from the intent's own
   * `meta.idempotencyKey` when the strategy set one (LaunchSniper passes its
   * discovery event ID — see launch-sniper.ts) — the strongest guarantee,
   * tying the order directly to the signal that caused it. Strategies
   * without a natural per-signal ID fall back to a key unique to this
   * specific tick's processing attempt, which still prevents an exact
   * double-submission of the same intent without claiming a stronger
   * signal-level guarantee it can't actually make.
   */
  private async executeLiveViaExecutor(
    executor: Executor,
    intent: Intent,
    sim: SwapQuote,
    slippageBps: number,
    now: number,
  ): Promise<LiveExecutionResult | null> {
    const idempotencyKey =
      (intent.meta?.idempotencyKey as string | undefined) ??
      `${this.id}:${intent.token}:${intent.side}:${now}`
    const order = await executor.execute({
      idempotencyKey,
      agentId: this.id,
      token: intent.token,
      quoteToken: intent.quoteToken,
      side: intent.side,
      amountIn: intent.amountIn,
      quote: sim,
      slippageBps,
    })
    if (
      !order.txHash ||
      (order.state !== 'RECONCILED' && order.state !== 'CONFIRMED' && order.state !== 'MINED')
    ) {
      return null // FAILED, or still genuinely in flight for a duplicate signal — see Executor's doc comment
    }
    const minOut = (sim.amountOut * BigInt(10_000 - slippageBps)) / 10_000n
    return { hash: order.txHash as Hash, amountOutMinimum: minOut, actualAmountOut: order.actualAmountOut }
  }

  private async executeLive(
    intent: Intent,
    sim: SwapQuote,
    slippageBps: number,
  ): Promise<LiveExecutionResult | null> {
    if (!this.account) return null
    try {
      const tx = buildSwapTx(this.market.client, sim, { slippageBps })
      await ensureApproval(
        this.market.client,
        intent.side === 'buy' ? intent.quoteToken : intent.token,
        intent.amountIn,
      )
      const hash = await this.market.client.wallet!.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        account: this.account,
        chain: this.market.client.chain,
      })
      await this.market.client.public.waitForTransactionReceipt({ hash })
      return { hash, amountOutMinimum: tx.amountOutMinimum, actualAmountOut: null }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  /** Returns the realized PnL delta on a sell (for {@link AgentOptions.reportTradeResult}); null for a buy or a no-op sell. */
  private applyFill(intent: Intent, amountOut: bigint, notionalUsd: number, now: number): number | null {
    const key = intent.token.toLowerCase()
    const existing = this.positions.get(key)
    if (intent.side === 'buy') {
      if (existing) {
        existing.amount += amountOut
        existing.costBasis += intent.amountIn
        existing.investedUsd += notionalUsd
      } else {
        this.positions.set(key, {
          token: intent.token,
          tokenSymbol: intent.tokenSymbol,
          amount: amountOut,
          costBasis: intent.amountIn,
          investedUsd: notionalUsd,
          quoteToken: intent.quoteToken,
          quoteSymbol: intent.quoteSymbol,
          openedAt: now,
          markUsd: null,
          meta: intent.meta ?? {},
        })
      }
      return null
    }
    // sell: realize PnL on the sold fraction
    if (!existing) return null
    const sellAmount = intent.amountIn > existing.amount ? existing.amount : intent.amountIn
    // fraction as a float only touches investedUsd (already a float, USD-scale — safe);
    // costBasis stays bigint-only arithmetic so large token-unit positions (amounts near
    // or past 2^53) don't lose precision through a Number() round-trip.
    const fraction = existing.amount > 0n ? Number(sellAmount) / Number(existing.amount) : 1
    const costFractionUsd = existing.investedUsd * fraction
    const costBasisSold =
      existing.amount > 0n ? (existing.costBasis * sellAmount) / existing.amount : existing.costBasis
    const realizedDelta = notionalUsd - costFractionUsd
    this.realizedUsd += realizedDelta
    existing.amount -= sellAmount
    existing.costBasis -= costBasisSold
    existing.investedUsd -= costFractionUsd
    if (existing.amount <= DUST) this.positions.delete(key)
    return realizedDelta
  }

  /** Mark every open position to its live exit value (a real sell-side quote). */
  private async markPositions(now: number): Promise<void> {
    for (const pos of this.positions.values()) {
      const q = await this.market.quoteSell(pos.token, pos.quoteToken, pos.amount)
      if (!q) {
        pos.markUsd = null
        continue
      }
      const quoteDecimals = pos.quoteSymbol === 'USDG' ? this.market.usdgDecimals : 18
      const ethUsd = pos.quoteSymbol === 'WETH' ? await this.market.ethUsd(30_000, now) : 1
      if (ethUsd === null) {
        pos.markUsd = null
        continue
      }
      pos.markUsd = Number(formatUnits(q.amountOut, quoteDecimals)) * ethUsd
    }
  }

  private openValueUsd(): number {
    let sum = 0
    for (const pos of this.positions.values()) sum += pos.markUsd ?? pos.investedUsd
    return sum
  }

  private recordEquity(now: number): void {
    const openValueUsd = this.openValueUsd()
    this.journal.recordEquity({
      agentId: this.id,
      ts: now,
      realizedUsd: round(this.realizedUsd),
      openValueUsd: round(openValueUsd),
      equityUsd: round(this.realizedUsd + openValueUsd),
    })
  }

  private rolloverDay(now: number): void {
    const day = utcDayStart(now)
    if (day !== this.spentDay) {
      this.spentDay = day
      this.spentTodayUsd = 0
    }
  }

  /** Live status snapshot for the dashboard API. */
  status(): AgentStatus {
    const openValueUsd = this.openValueUsd()
    return {
      id: this.id,
      strategy: this.strategy.id,
      mode: this.mode,
      running: this.running,
      killed: this.kill.isKilled(),
      limits: this.risk.riskLimits,
      spentTodayUsd: round(this.spentTodayUsd),
      realizedUsd: round(this.realizedUsd),
      openValueUsd: round(openValueUsd),
      equityUsd: round(this.realizedUsd + openValueUsd),
      positions: [...this.positions.values()],
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      ticks: this.ticks,
      trades: this.trades,
      refusals: this.refusals,
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
