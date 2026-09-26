import { erc20Abi, type Launch } from 'hoodchain'
import { formatUnits, parseEther, type Address } from 'viem'
import type { Strategy, StrategyMeta, StrategyTickContext } from '../framework/strategy.js'
import type { Decision, Intent, Alert, Position } from '../framework/types.js'
import { EventQueue } from '../discovery/event-queue.js'
import { LAUNCH_KIND, decodeLaunchPayload } from '../discovery/launch-detector.js'
import {
  evaluateExit,
  INITIAL_EXIT_STATE,
  DEFAULT_EXIT_CONFIG,
  type ExitState,
  type ExitTierConfig,
} from '../exits/exit-engine.js'

/** Tunables for {@link LaunchSniper}. */
export interface LaunchSniperParams {
  /** WETH spent per entry. */
  entryWeth: number
  /** Level 9 exit tier ladder — stop loss / TP1 / TP2 / trailing stop (see exits/exit-engine.ts). Merged over the defaults, so passing just e.g. `{ stopLossPct: 0.2 }` leaves TP1/TP2/trailing untouched. */
  exitConfig: Partial<ExitTierConfig>
  /** Force-exit a position after this many seconds regardless of PnL — independent of the tier ladder (a plain time cap, not itself a tier). */
  maxHoldSeconds: number
  /** Reject a launch if the deployer still holds more than this fraction of supply. */
  maxDeployerPct: number
  /** Reject if an immediate buy→sell round trip would lose more than this fraction (honeypot/thin-pool guard). */
  maxRoundTripLossPct: number
  /** Only consider launches at most this many seconds old when first seen. */
  maxLaunchAgeSeconds: number
}

const DEFAULTS: LaunchSniperParams = {
  entryWeth: 0.01,
  exitConfig: {},
  maxHoldSeconds: 30 * 60,
  maxDeployerPct: 0.15,
  maxRoundTripLossPct: 0.35,
  maxLaunchAgeSeconds: 5 * 60,
}

/**
 * launch-sniper — enter brand-new launchpad coins that clear objective safety
 * filters, then exit on take-profit, stop, or a hard time limit.
 *
 * EDGE HYPOTHESIS: the first minutes after a NOXA instant-listing are the most
 * information-rich and most volatile window a memecoin ever has. A disciplined
 * buyer who (a) only touches tokens that are actually round-trippable (not
 * honeypots) and whose deployer is not sitting on the supply, and (b) exits
 * mechanically instead of falling in love, harvests a slice of that opening
 * volatility. The edge is speed + discipline, not prediction.
 *
 * FAILURE MODES: most new launches go to zero — the stop loss WILL fire often
 * and the strategy is negative-carry unless the winners pay for the losers.
 * Honeypots evolve (sell-tax toggled AFTER you buy); the round-trip check only
 * sees the state at entry. Odyssey tokens on the bonding curve have no Uniswap
 * pool yet, so they are skipped until graduation — this strategy is really a
 * NOXA/graduated-pool sniper. Paper fills assume the QuoterV2 mid; a real
 * sniper competes with faster bots and eats worse fills.
 */
export class LaunchSniper implements Strategy {
  readonly id = 'launch-sniper'
  readonly title = 'Launch Sniper'
  readonly quote = 'weth' as const
  private readonly p: LaunchSniperParams
  private readonly queue: EventQueue

  /**
   * `queue` is the durable discovery queue — see {@link
   * ../discovery/event-queue.js}. In production wiring (main.ts) this is a
   * disk-backed queue shared with a {@link
   * ../discovery/launch-detector.js!LaunchDetector} that owns the actual
   * chain subscription; this strategy only ever claims already-persisted,
   * confirmation-safe events, so a dropped in-process array can no longer
   * lose a candidate on a crash/restart. Defaults to an in-memory queue so
   * existing standalone construction (tests, `new LaunchSniper()`) keeps
   * working without requiring every caller to wire discovery.
   */
  private readonly exitConfig: ExitTierConfig

  constructor(params: Partial<LaunchSniperParams> = {}, queue: EventQueue = new EventQueue(':memory:')) {
    this.p = { ...DEFAULTS, ...params }
    this.queue = queue
    this.exitConfig = { ...DEFAULT_EXIT_CONFIG, ...this.p.exitConfig }
  }

  get meta(): StrategyMeta {
    return {
      edge:
        'Harvest opening-minutes volatility of freshly launched memecoins by buying only round-trippable, ' +
        'non-deployer-heavy launches and exiting mechanically on TP/stop/time.',
      failureModes: [
        'Most launches trend to zero — the stop loss fires frequently; profitability depends on winners covering losers.',
        'Honeypots can enable a sell tax AFTER entry; the entry-time round-trip check cannot see that.',
        'Odyssey bonding-curve tokens have no Uniswap pool pre-graduation and are skipped (this is effectively a NOXA sniper).',
        'Paper fills use the QuoterV2 mid; live, faster bots win the best fills and you eat slippage.',
      ],
      params: { ...this.p },
    }
  }

  async tick(ctx: StrategyTickContext): Promise<Decision> {
    const intents: Intent[] = []
    const alerts: Alert[] = []

    // ── exits first (protect open risk before taking on more) ──────────────────
    // Level 9 tier ladder: stop-loss (full exit) / TP1 (sell 25% of original)
    // / TP2 (sell another 25% of original) / trailing stop on the remaining
    // 50% — see exits/exit-engine.ts. Exit state (which tiers have already
    // fired, the post-TP2 peak) is persisted in `pos.meta.exitState` across
    // ticks, since `pos` is the same object Agent holds internally.
    for (const pos of ctx.positions) {
      const ageSec = (ctx.now - pos.openedAt) / 1000
      const pnlPct = pos.markUsd !== null && pos.investedUsd > 0 ? pos.markUsd / pos.investedUsd - 1 : null

      if (pnlPct === null) {
        if (ageSec >= this.p.maxHoldSeconds) {
          intents.push(
            sellIntent(pos, 1, `time-exit ${Math.round(ageSec)}s held (no live mark to judge PnL against)`),
          )
        }
        continue
      }

      const exitState = (pos.meta.exitState as ExitState | undefined) ?? INITIAL_EXIT_STATE
      const { decision, newState } = evaluateExit(pnlPct, exitState, this.exitConfig)
      pos.meta.exitState = newState

      if (decision) {
        intents.push(
          sellIntent(pos, decision.sellFractionOfCurrent, decision.reason, { pnlPct, tier: decision.tier }),
        )
      } else if (ageSec >= this.p.maxHoldSeconds) {
        intents.push(sellIntent(pos, 1, `time-exit ${Math.round(ageSec)}s held`, { pnlPct }))
      }
    }

    // ── one new entry per tick (claim the oldest queued, confirmation-safe launch) ──
    const claimed = this.queue.claimNext(LAUNCH_KIND, ctx.now)
    if (claimed) {
      try {
        const launch = decodeLaunchPayload(claimed.payload)
        const decisionOrReject = await this.evaluate(ctx, launch, claimed.detectedAt)
        this.queue.markEnriched(claimed.eventId, ctx.now) // safety/liquidity checks above have now run
        if (decisionOrReject.intent) {
          // Ties the order directly to the discovery event that caused it —
          // see Agent.executeLiveViaExecutor's doc comment (Level 6): this is
          // the strong form of order_idempotency_key, not the per-tick fallback.
          decisionOrReject.intent.meta = { ...decisionOrReject.intent.meta, idempotencyKey: claimed.eventId }
          intents.push(decisionOrReject.intent)
          this.queue.markDecisioned(claimed.eventId, ctx.now)
        } else if (decisionOrReject.alert) {
          alerts.push(decisionOrReject.alert)
          this.queue.markRejected(claimed.eventId, decisionOrReject.alert.message)
        } else {
          // Already holding this token — not a rejection, just not actionable right now.
          this.queue.markRejected(claimed.eventId, 'already holding a position in this token')
        }
      } catch (err) {
        // Every claimed event must reach a terminal state — an unexpected
        // exception here must not strand the row in `processing` forever.
        this.queue.markError(claimed.eventId, err instanceof Error ? err.message : String(err))
      }
    }

    return { intents, alerts }
  }

  private async evaluate(
    ctx: StrategyTickContext,
    launch: Launch,
    detectedAt: number,
  ): Promise<{ intent?: Intent; alert?: Alert }> {
    const ageSec = (ctx.now - detectedAt) / 1000
    if (ageSec > this.p.maxLaunchAgeSeconds) {
      return {
        alert: {
          level: 'info',
          message: `skip ${launch.token}: stale (${Math.round(ageSec)}s old)`,
          meta: {},
        },
      }
    }
    // already holding it?
    if (ctx.positions.some((p) => p.token.toLowerCase() === launch.token.toLowerCase())) return {}

    const amountIn = parseEther(String(this.p.entryWeth))

    // Filter 1 — route exists (Odyssey pre-graduation tokens fail here and are skipped).
    const buyQuote = await ctx.market.quoteBuy(ctx.quoteToken, launch.token, amountIn)
    if (!buyQuote || buyQuote.amountOut <= 0n) {
      return {
        alert: {
          level: 'info',
          message: `skip ${launch.token}: no liquid Uniswap route`,
          meta: { launchpad: launch.launchpad },
        },
      }
    }

    // Filter 2 — round-trip retention (honeypot / thin-pool guard).
    const sellQuote = await ctx.market.quoteSell(launch.token, ctx.quoteToken, buyQuote.amountOut)
    if (!sellQuote || sellQuote.amountOut <= 0n) {
      return {
        alert: { level: 'warn', message: `skip ${launch.token}: cannot sell back (honeypot?)`, meta: {} },
      }
    }
    const retention = Number(sellQuote.amountOut) / Number(amountIn)
    if (1 - retention > this.p.maxRoundTripLossPct) {
      return {
        alert: {
          level: 'warn',
          message: `skip ${launch.token}: round-trip loss ${((1 - retention) * 100).toFixed(1)}% > ${(this.p.maxRoundTripLossPct * 100).toFixed(0)}%`,
          meta: { retention },
        },
      }
    }

    // Filter 3 — deployer concentration.
    const deployerPct = await this.deployerConcentration(ctx, launch)
    if (deployerPct !== null && deployerPct > this.p.maxDeployerPct) {
      return {
        alert: {
          level: 'warn',
          message: `skip ${launch.token}: deployer holds ${(deployerPct * 100).toFixed(1)}% > ${(this.p.maxDeployerPct * 100).toFixed(0)}%`,
          meta: { deployerPct },
        },
      }
    }

    return {
      intent: {
        side: 'buy',
        token: launch.token,
        tokenSymbol: shortToken(launch.token),
        amountIn,
        quoteToken: ctx.quoteToken,
        quoteSymbol: ctx.quoteSymbol,
        reason: `sniped ${launch.launchpad} launch — retention ${(retention * 100).toFixed(1)}%, deployer ${deployerPct === null ? 'n/a' : (deployerPct * 100).toFixed(1) + '%'}`,
        meta: { launchpad: launch.launchpad, deployerPct, retention, deployerAddress: launch.creator },
      },
    }
  }

  private async deployerConcentration(ctx: StrategyTickContext, launch: Launch): Promise<number | null> {
    try {
      const [supply, bal] = await ctx.market.client.public.multicall({
        contracts: [
          { address: launch.token, abi: erc20Abi, functionName: 'totalSupply' as const },
          {
            address: launch.token,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [launch.creator] as const,
          },
        ],
        allowFailure: false,
      })
      if ((supply as bigint) === 0n) return null
      return Number(formatUnits(((bal as bigint) * 10_000n) / (supply as bigint), 4))
    } catch {
      return null
    }
  }
}

function shortToken(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Builds a sell Intent for `fractionOfCurrent` (0-1) of a position's CURRENTLY held amount. */
function sellIntent(
  pos: Position,
  fractionOfCurrent: number,
  reason: string,
  extraMeta: Record<string, unknown> = {},
): Intent {
  const fractionBps = BigInt(Math.round(Math.max(0, Math.min(1, fractionOfCurrent)) * 10_000))
  const amountIn = fractionBps >= 10_000n ? pos.amount : (pos.amount * fractionBps) / 10_000n
  return {
    side: 'sell',
    token: pos.token,
    tokenSymbol: pos.tokenSymbol,
    amountIn,
    quoteToken: pos.quoteToken,
    quoteSymbol: pos.quoteSymbol,
    reason,
    meta: extraMeta,
  }
}
