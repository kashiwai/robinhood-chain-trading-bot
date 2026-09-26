import { formatUnits, type Account, type Address, type Hash } from 'viem'
import { buildSwapTx, ensureApproval, type SwapQuote } from 'hoodchain'
import type { Journal } from './journal.js'
import type { Market } from './market.js'
import { RiskEngine, utcDayStart } from './risk.js'
import type { KillSwitch } from './kill.js'
import type { Strategy } from './strategy.js'
import type { AgentStatus, Decision, Intent, Mode, Position, RiskLimits, TradeRecord } from './types.js'
import type { Executor } from '../execution/executor.js'
import type { OrderState } from '../execution/order-store.js'
import type { ProbeGate } from '../execution/probe-gate.js'
import type { CircuitBreaker } from '../risk/circuit-breaker.js'
import { checkAccountRisk, type AccountRiskContext } from '../risk/account-risk.js'
import type { AccountRiskProfile } from '../risk/risk-profile.js'
import { checkEmergencyExit } from '../exits/emergency-exit.js'
import {
  buildEmergencyExitInput,
  NEUTRAL_ENTRY_SNAPSHOT,
  type EmergencyEntrySnapshot,
  type EmergencyMonitorHooks,
} from '../exits/emergency-monitor.js'
import type { TelegramAlerter } from '../alerts/telegram.js'

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
  /**
   * Level 10.1: real Level-5/wallet-intel scanners feeding the emergency-exit
   * layer (see exits/emergency-monitor.ts). Optional — absent means the two
   * Agent-native checks (sellability, quote anomaly) still protect every
   * position in every mode; only the scanner-dependent checks (liquidity
   * collapse, contract-risk jump, retention drop, deployer dump, smart-money
   * exit, sell-pressure spike) are unavailable.
   */
  emergencyMonitor?: EmergencyMonitorHooks
  /** Minimum ms between real emergency rescans per position — `emergencyMonitor.currentSignals` is real IO and must not run every tick. @defaultValue 60000 */
  emergencyRescanIntervalMs?: number
  /** Level 10.1: send-only critical alerts (REAL_BUY/REAL_SELL/SELL_FAILURE/EMERGENCY_EXIT) — see alerts/telegram.ts. Optional; a missing alerter simply means no notification, never a blocked trade. */
  telegramAlerter?: Pick<TelegramAlerter, 'send'>
}

/** Deterministic, restart-stable identity for a position's lifetime — used for the emergency-exit idempotency key and journal correlation. */
function positionKey(pos: Pick<Position, 'token' | 'openedAt'>): string {
  return `${pos.token.toLowerCase()}:${pos.openedAt}`
}

const DUST = 1_000n // token smallest-units below which a position is considered closed
const QUOTE_ANOMALY_DROP_RATIO = 0.5 // a mark-to-mark drop of 50%+ in one tick counts as a quote anomaly
const SELL_QUOTE_FAIL_STREAK_THRESHOLD = 3 // consecutive failed sell-quotes before treating it as a real sellability loss, not RPC noise

interface LiveExecutionResult {
  hash: Hash
  /** Quoted floor (post-slippage) — always populated, the pre-Level-6 fallback figure. */
  amountOutMinimum: bigint
  /** Real reconciled fill (Level 6, Executor path only) — null on the plain inline-executeLive path. */
  actualAmountOut: bigint | null
  /** Level 6 order lifecycle terminal state (see execution/order-store.ts) — null on the plain inline-executeLive path, which has no order-store tracking. */
  orderState: OrderState | null
  /** The idempotency key the order was created/looked-up under — null on the plain inline-executeLive path. */
  idempotencyKey: string | null
}

/** What actually happened to one processed intent — returned so callers (notably the emergency-exit path) can journal the real result without re-deriving it from side effects. */
export interface IntentOutcome {
  success: boolean
  txHash: Hash | null
  idempotencyKey: string | null
  orderState: OrderState | null
  refusalReason: string | null
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
  /** Positions with an emergency-exit sell currently being attempted — see monitorPositions()'s doc comment for why this, alongside the deterministic idempotency key, is the double-SELL guard. */
  private readonly emergencyExitInFlight = new Set<string>()
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
      // ── Level 10.1: emergency exit — evaluated for every open position, in
      // every mode, BEFORE the strategy gets a turn this tick. If a full exit
      // fires here, the position is gone (or refused-and-unchanged) by the
      // time decide() below snapshots positions for the strategy, so a
      // strategy's own hard-stop/take-profit/trailing logic can never race
      // it — "EMERGENCY EXIT → HARD STOP LOSS → NORMAL EXIT" is enforced by
      // this ordering, not a shared priority-queue data structure. Still
      // subject to the kill switch, same as every other order (processIntent
      // -> RiskEngine.check refuses with kill_switch — no separate bypass).
      await this.monitorPositions(now)

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

  /**
   * Returns what actually happened — success/refusal, txHash, the Level 6
   * order's idempotency key and terminal state where applicable — so callers
   * that need to journal a richer outcome (the emergency-exit path; see
   * fireEmergencyExit) don't have to re-derive it from side effects. Every
   * existing caller (the plain per-tick intent loop) simply ignores the
   * return value, so this is additive, not a behavior change.
   */
  private async processIntent(intent: Intent, now: number): Promise<IntentOutcome> {
    const refuse = (reason: string, detail: string, meta: Record<string, unknown> = {}): IntentOutcome => {
      this.refusals++
      this.journal.recordDecision({
        agentId: this.id,
        ts: now,
        kind: 'refused',
        detail: `${intent.side} ${intent.tokenSymbol}: ${detail}`,
        meta: { reason, intentReason: intent.reason, ...meta },
      })
      // SELL_FAILURE — live mode only, and only for a sell (a refused BUY is
      // routine risk-gating, not an alert-worthy failure). Emergency-exit
      // sells get their own richer EMERGENCY_EXIT alert instead, so this
      // skips anything tagged `meta.emergencyExit` to avoid double-alerting
      // the same event.
      if (this.mode === 'live' && intent.side === 'sell' && !intent.meta?.emergencyExit) {
        void this.opts.telegramAlerter?.send(
          'SELL_FAILURE',
          `${intent.tokenSymbol}: ${detail} (reason=${reason})`,
        )
      }
      return { success: false, txHash: null, idempotencyKey: null, orderState: null, refusalReason: reason }
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
      return refuse('no_route', 'no liquid route to simulate the fill')
    }

    // ── notional in USD ────────────────────────────────────────────────────────
    const ethUsd = intent.quoteSymbol === 'WETH' ? await this.market.ethUsd(30_000, now) : 1
    if (ethUsd === null) {
      return refuse('no_route', 'cannot price ETH to enforce USD caps')
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
        return refuse('insufficient_balance', 'position too small to sell requested amount')
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
      return refuse(verdict.reason ?? 'refused', verdict.detail, { notionalUsd: round(notionalUsd) })
    }

    // ── Level 7: circuit breaker + account-wide risk (buys only — sells always pass, same principle as above) ──
    if (intent.side === 'buy') {
      if (this.opts.circuitBreaker?.buyPaused()) {
        const conditions = this.opts.circuitBreaker
          .activeConditions()
          .map((c) => c.condition)
          .join(', ')
        return refuse('circuit_breaker', `BUY paused — active breaker(s): ${conditions}`, {
          notionalUsd: round(notionalUsd),
        })
      }
      if (this.opts.accountRisk) {
        const accountVerdict = checkAccountRisk(
          this.opts.accountRisk.contextProvider(notionalUsd),
          this.opts.accountRisk.profile,
        )
        if (!accountVerdict.ok) {
          return refuse(accountVerdict.reason ?? 'account_risk', accountVerdict.detail, {
            notionalUsd: round(notionalUsd),
          })
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
          const reasonByAction: Record<'blacklisted' | 'quarantined' | 'probed', string> = {
            blacklisted: 'probe_blacklisted',
            quarantined: 'probe_quarantined',
            probed: 'probe_ran_this_tick',
          }
          return refuse(reasonByAction[gate.action], gate.reason, { notionalUsd: round(notionalUsd) })
        }
      }
    }

    // ── Level 10.1: capture the emergency-exit entry snapshot on a brand-new
    // buy — real IO (Level 5 scans), only when a position doesn't already
    // exist for this token, so a subsequent add-on buy never overwrites the
    // original baseline. Stored into intent.meta so applyFill's normal
    // meta-copy-onto-position path carries it, same as every other
    // strategy-supplied meta field. ──
    if (intent.side === 'buy' && !existing && this.opts.emergencyMonitor) {
      try {
        const entry = await this.opts.emergencyMonitor.captureEntry(
          intent.token,
          quoteToken,
          now,
          intent.meta ?? {},
        )
        intent.meta = { ...(intent.meta ?? {}), emergencyEntry: entry }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        // Entry-snapshot capture failing must never block the buy itself — it
        // just means this position falls back to the neutral (never-trips)
        // baseline until a later mechanism (there is none yet) backfills it.
      }
    }

    // ── execute ────────────────────────────────────────────────────────────────
    let txHash: Hash | null = null
    let amountOut = sim.amountOut
    let orderState: OrderState | null = null
    let idempotencyKey: string | null = null
    if (this.mode === 'live') {
      const executed = this.opts.executor
        ? await this.executeLiveViaExecutor(this.opts.executor, intent, sim, slippageBps, now)
        : await this.executeLive(intent, sim, slippageBps)
      if (!executed) {
        return refuse('no_route', 'live execution failed (see logs)')
      }
      txHash = executed.hash
      orderState = executed.orderState
      idempotencyKey = executed.idempotencyKey
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
    if (this.mode === 'live') {
      void this.opts.telegramAlerter?.send(
        intent.side === 'buy' ? 'REAL_BUY' : 'REAL_SELL',
        `${intent.tokenSymbol} $${round(notionalUsd)} tx=${txHash ?? 'n/a'}`,
      )
    }
    return { success: true, txHash, idempotencyKey, orderState, refusalReason: null }
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
    return {
      hash: order.txHash as Hash,
      amountOutMinimum: minOut,
      actualAmountOut: order.actualAmountOut,
      orderState: order.state,
      idempotencyKey,
    }
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
      return {
        hash,
        amountOutMinimum: tx.amountOutMinimum,
        actualAmountOut: null,
        orderState: null,
        idempotencyKey: null,
      }
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

  /**
   * Mark every open position to its live exit value (a real sell-side
   * quote). Also computes, at zero extra IO cost, the two emergency-exit
   * signals Agent owns outright (see exits/emergency-monitor.ts):
   * `sellQuoteOk` (has the sell-quote failed `SELL_QUOTE_FAIL_STREAK_THRESHOLD`
   * ticks IN A ROW — a single blip is treated as noise, not a honeypot
   * signature, since a transient RPC hiccup is far more common than a real
   * sudden total loss of sellability) and `quoteAnomalyDetected` (did the
   * mark crash more than `QUOTE_ANOMALY_DROP_RATIO` in a single tick) —
   * stored in `pos.meta` so monitorPositions can read them without
   * recomputing.
   */
  private async markPositions(now: number): Promise<void> {
    for (const pos of this.positions.values()) {
      const prevMarkUsd = pos.markUsd
      const failStreak = (pos.meta.sellQuoteFailStreak as number | undefined) ?? 0
      const q = await this.market.quoteSell(pos.token, pos.quoteToken, pos.amount)
      if (!q || q.amountOut <= 0n) {
        pos.markUsd = null
        const newFailStreak = failStreak + 1
        pos.meta.sellQuoteFailStreak = newFailStreak
        pos.meta.sellQuoteOk = newFailStreak < SELL_QUOTE_FAIL_STREAK_THRESHOLD
        pos.meta.quoteAnomalyDetected = false
        continue
      }
      pos.meta.sellQuoteFailStreak = 0
      pos.meta.sellQuoteOk = true
      const quoteDecimals = pos.quoteSymbol === 'USDG' ? this.market.usdgDecimals : 18
      const ethUsd = pos.quoteSymbol === 'WETH' ? await this.market.ethUsd(30_000, now) : 1
      if (ethUsd === null) {
        pos.markUsd = null
        pos.meta.quoteAnomalyDetected = false
        continue
      }
      pos.markUsd = Number(formatUnits(q.amountOut, quoteDecimals)) * ethUsd
      pos.meta.quoteAnomalyDetected =
        prevMarkUsd !== null && prevMarkUsd > 0 && pos.markUsd < prevMarkUsd * (1 - QUOTE_ANOMALY_DROP_RATIO)
    }
  }

  /**
   * Level 10.1 — the emergency-exit layer. Runs every tick, for every open
   * position, in every mode (Shadow/Paper/Probe/Live all go through
   * Agent.tick() -> markPositions() -> here), independent of whatever the
   * strategy itself would decide this tick. Never calls out to an LLM/JEV —
   * `checkEmergencyExit` is pure, synchronous logic over already-fetched
   * signals, so there is nothing to "wait for".
   */
  private async monitorPositions(now: number): Promise<void> {
    for (const pos of [...this.positions.values()]) {
      const key = positionKey(pos)
      if (this.emergencyExitInFlight.has(key)) continue // an attempt for this exact position is already running this tick
      const trigger = await this.evaluateEmergencyExit(pos, now)
      if (!trigger) continue
      this.emergencyExitInFlight.add(key)
      try {
        await this.fireEmergencyExit(pos, trigger, now)
      } finally {
        this.emergencyExitInFlight.delete(key)
      }
    }
  }

  private async evaluateEmergencyExit(
    pos: Position,
    now: number,
  ): Promise<{ reasons: string[]; input: ReturnType<typeof buildEmergencyExitInput> } | null> {
    const entry = (pos.meta.emergencyEntry as EmergencyEntrySnapshot | undefined) ?? NEUTRAL_ENTRY_SNAPSHOT
    const rescanIntervalMs = this.opts.emergencyRescanIntervalMs ?? 60_000
    const lastScanAt = (pos.meta.lastEmergencyScanAt as number | undefined) ?? 0
    let scanned = (pos.meta.lastEmergencySignals as Record<string, unknown> | undefined) ?? {}
    if (this.opts.emergencyMonitor && now - lastScanAt >= rescanIntervalMs) {
      try {
        scanned = await this.opts.emergencyMonitor.currentSignals(pos.token, pos.quoteToken, entry, now)
        pos.meta.lastEmergencyScanAt = now
        pos.meta.lastEmergencySignals = scanned
      } catch (err) {
        // A failed rescan must not itself trigger or suppress an emergency
        // exit — fail open on this EXTRA layer only, keep whatever was
        // cached (or the neutral default on the very first scan).
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    const input = buildEmergencyExitInput(entry, scanned, {
      currentlySellable: pos.meta.sellQuoteOk !== false,
      quoteAnomalyDetected: pos.meta.quoteAnomalyDetected === true,
    })
    const verdict = checkEmergencyExit(input)
    return verdict.shouldExit ? { reasons: verdict.reasons, input } : null
  }

  /**
   * Journals the trigger (position id, token, reasons, the full signal
   * snapshot, current mark, liquidity, sellability, timestamp) BEFORE
   * attempting the sell, then attempts a full exit through the exact same
   * `processIntent` pipeline every other order goes through — same risk
   * gate, same kill-switch respect, same Level 6 execution when live — and
   * journals the outcome (order id, result, reconciliation state)
   * afterward. A failed sell leaves the position exactly as `processIntent`
   * always leaves a refused/failed order: untouched, since `applyFill` is
   * only ever reached on the success path.
   */
  private async fireEmergencyExit(
    pos: Position,
    trigger: { reasons: string[]; input: ReturnType<typeof buildEmergencyExitInput> },
    now: number,
  ): Promise<void> {
    const key = positionKey(pos)
    const idempotencyKey = `emergency-exit:${key}`
    this.journal.recordDecision({
      agentId: this.id,
      ts: now,
      kind: 'emergency_exit',
      detail: `EMERGENCY EXIT ${pos.tokenSymbol}: ${trigger.reasons.join(', ')}`,
      meta: {
        positionId: key,
        token: pos.token,
        trigger: trigger.reasons,
        triggerValues: trigger.input,
        timestamp: now,
        currentQuote: pos.markUsd,
        liquidity: trigger.input.currentLiquidityScore,
        sellability: trigger.input.currentlySellable,
        phase: 'triggered',
      },
    })

    const sellIntent: Intent = {
      side: 'sell',
      token: pos.token,
      tokenSymbol: pos.tokenSymbol,
      amountIn: pos.amount,
      quoteToken: pos.quoteToken,
      quoteSymbol: pos.quoteSymbol,
      reason: `EMERGENCY EXIT: ${trigger.reasons.join(', ')}`,
      meta: { idempotencyKey, emergencyExit: true, positionId: key, trigger: trigger.reasons },
    }
    const outcome = await this.processIntent(sellIntent, now)

    this.journal.recordDecision({
      agentId: this.id,
      ts: now,
      kind: 'emergency_exit',
      detail: `EMERGENCY EXIT ${pos.tokenSymbol} result: ${outcome.success ? 'sold' : `failed (${outcome.refusalReason})`}`,
      meta: {
        positionId: key,
        token: pos.token,
        trigger: trigger.reasons,
        triggerValues: trigger.input,
        timestamp: now,
        currentQuote: pos.markUsd,
        liquidity: trigger.input.currentLiquidityScore,
        sellability: trigger.input.currentlySellable,
        phase: 'resolved',
        orderId: outcome.idempotencyKey,
        txHash: outcome.txHash,
        result: outcome.success ? 'sold' : 'failed',
        reconciliationResult: outcome.orderState,
        refusalReason: outcome.refusalReason,
      },
    })
    void this.opts.telegramAlerter?.send(
      'EMERGENCY_EXIT',
      `${pos.tokenSymbol}: ${trigger.reasons.join(', ')} — ${outcome.success ? 'sold' : `sell FAILED (${outcome.refusalReason})`}`,
    )
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
