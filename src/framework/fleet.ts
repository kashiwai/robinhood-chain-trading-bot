import { privateKeyToAccount } from 'viem/accounts'
import type { Account } from 'viem'
import { Agent } from './agent.js'
import type { FleetConfig } from './config.js'
import { Journal } from './journal.js'
import { KillSwitch } from './kill.js'
import { Market } from './market.js'
import { utcDayStart } from './risk.js'
import type { Strategy } from './strategy.js'
import type { AgentStatus, Mode, RiskLimits } from './types.js'
import type { Executor } from '../execution/executor.js'
import type { CircuitBreaker } from '../risk/circuit-breaker.js'
import { DEFAULT_RISK_PROFILE, type AccountRiskProfile } from '../risk/risk-profile.js'
import type { AccountRiskContext } from '../risk/account-risk.js'

/** Definition of one agent within a fleet. */
export interface AgentSpec {
  id: string
  strategy: Strategy
  /** Overrides merged over the fleet default limits. */
  limits?: Partial<RiskLimits>
  tickIntervalMs?: number
  /** Level 6 execution engine — see agent.ts's AgentOptions.executor doc comment. */
  executor?: Executor
  /** Level 7 circuit breaker — see agent.ts's AgentOptions.circuitBreaker doc comment. */
  circuitBreaker?: CircuitBreaker
}

/** Aggregate fleet numbers for the dashboard header. */
export interface FleetSummary {
  network: string
  mode: Mode
  killed: boolean
  killReason: string | null
  fleetSpentTodayUsd: number
  fleetMaxDailySpendUsdg: number
  realizedUsd: number
  openValueUsd: number
  equityUsd: number
  agents: number
  startedAt: number
}

/**
 * The fleet: owns the shared market client, journal, and kill switch, then runs
 * a set of agents against them and tracks the global daily-spend budget. It is
 * the process-level object the dashboard server reads and the kill switch acts
 * on.
 */
export class Fleet {
  readonly config: FleetConfig
  readonly journal: Journal
  readonly kill: KillSwitch
  readonly market: Market
  private readonly account: Account | null
  private readonly agents: Agent[] = []
  private fleetSpentTodayUsd = 0
  private spentDay = 0
  private startedAt = 0

  // ── Level 7: account-wide risk tracking (see risk/account-risk.ts) ─────────
  readonly riskProfile: AccountRiskProfile
  private cumulativeRealizedPnlUsd = 0
  private consecutiveLosses = 0
  private dailyRealizedPnlUsd = 0
  private dailyPnlDay = 0
  private equityPeakAllTime = 0
  private equityHistory7d: { ts: number; equity: number }[] = []

  constructor(config: FleetConfig, riskProfile: AccountRiskProfile = DEFAULT_RISK_PROFILE) {
    this.config = config
    this.riskProfile = riskProfile
    this.account = config.privateKey ? privateKeyToAccount(config.privateKey) : null
    this.journal = new Journal(config.dbPath)
    this.kill = new KillSwitch(config.killFile)
    this.market = new Market(config, this.account ?? undefined)
  }

  /** Build agents from specs. */
  addAgents(specs: AgentSpec[]): void {
    for (const spec of specs) {
      const limits: RiskLimits = { ...this.config.defaultLimits, ...spec.limits }
      this.agents.push(
        new Agent({
          id: spec.id,
          strategy: spec.strategy,
          market: this.market,
          limits,
          journal: this.journal,
          kill: this.kill,
          mode: this.config.mode,
          account: this.account,
          fleetMaxDailySpendUsdg: this.config.fleetMaxDailySpendUsdg,
          fleetSpentTodayUsd: () => this.currentFleetSpend(),
          reportFleetSpend: (usd) => this.recordFleetSpend(usd),
          tickIntervalMs: spec.tickIntervalMs ?? 5000,
          executor: spec.executor,
          circuitBreaker: spec.circuitBreaker,
          accountRisk: {
            profile: this.riskProfile,
            contextProvider: (candidateUsd) => this.accountRiskContext(candidateUsd),
          },
          reportTradeResult: (pnlUsd) => this.recordTradeResult(pnlUsd),
        }),
      )
    }
  }

  private currentFleetSpend(now = Date.now()): number {
    const day = utcDayStart(now)
    if (day !== this.spentDay) {
      this.spentDay = day
      this.fleetSpentTodayUsd = 0
    }
    return this.fleetSpentTodayUsd
  }

  private recordFleetSpend(usd: number): void {
    this.currentFleetSpend()
    this.fleetSpentTodayUsd += usd
  }

  /**
   * Called by every agent after a sell closes (realized PnL delta, positive
   * or negative). Feeds the $1,000 profile's daily-loss, drawdown, and
   * consecutive-loss ceilings — see risk/account-risk.ts. Drawdown is
   * measured against `riskProfile.accountLimitUsd` (the starting capital),
   * not against the peak itself, so it reads as "% of your account", matching
   * how the spec phrases MAX_7D_DRAWDOWN_PCT/MAX_TOTAL_DRAWDOWN_PCT.
   */
  private recordTradeResult(pnlUsd: number, now = Date.now()): void {
    this.cumulativeRealizedPnlUsd += pnlUsd
    if (pnlUsd < 0) this.consecutiveLosses += 1
    else if (pnlUsd > 0) this.consecutiveLosses = 0

    const day = utcDayStart(now)
    if (day !== this.dailyPnlDay) {
      this.dailyPnlDay = day
      this.dailyRealizedPnlUsd = 0
    }
    this.dailyRealizedPnlUsd += pnlUsd

    this.equityPeakAllTime = Math.max(this.equityPeakAllTime, this.cumulativeRealizedPnlUsd)
    this.equityHistory7d.push({ ts: now, equity: this.cumulativeRealizedPnlUsd })
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    this.equityHistory7d = this.equityHistory7d.filter((e) => e.ts >= cutoff)
  }

  private accountRiskContext(candidatePositionUsd: number): AccountRiskContext {
    const statuses = this.agentStatuses()
    const peak7d =
      this.equityHistory7d.length > 0
        ? Math.max(...this.equityHistory7d.map((e) => e.equity))
        : this.cumulativeRealizedPnlUsd
    const accountLimitUsd = this.riskProfile.accountLimitUsd || 1
    return {
      openPositionsCount: statuses.reduce((s, a) => s + a.positions.length, 0),
      totalExposureUsd: statuses.reduce((s, a) => s + a.openValueUsd, 0),
      candidatePositionUsd,
      dailyRealizedLossUsd: Math.max(0, -this.dailyRealizedPnlUsd),
      drawdown7dPct: (Math.max(0, peak7d - this.cumulativeRealizedPnlUsd) / accountLimitUsd) * 100,
      totalDrawdownPct:
        (Math.max(0, this.equityPeakAllTime - this.cumulativeRealizedPnlUsd) / accountLimitUsd) * 100,
      consecutiveLosses: this.consecutiveLosses,
    }
  }

  /** Arm the kill switch and start every agent's loop. */
  async start(): Promise<void> {
    this.startedAt = Date.now()
    this.kill.arm()
    await Promise.all(this.agents.map((a) => a.start()))
  }

  /** Stop all agents (kill switch stays tripped if it was). */
  stop(): void {
    for (const a of this.agents) a.stop()
  }

  /** Run exactly one tick per agent, in parallel, without arming the interval scheduler. Used by E2E tests. */
  async tickAllOnce(): Promise<void> {
    await Promise.all(this.agents.map((a) => a.tick()))
  }

  /** Trip the kill switch — halts new orders across the fleet. */
  tripKill(reason: string): void {
    this.kill.trip(reason)
  }

  agentStatuses(): AgentStatus[] {
    return this.agents.map((a) => a.status())
  }

  summary(): FleetSummary {
    const statuses = this.agentStatuses()
    return {
      network: this.config.network,
      mode: this.config.mode,
      killed: this.kill.isKilled(),
      killReason: this.kill.killReason(),
      fleetSpentTodayUsd: round(this.currentFleetSpend()),
      fleetMaxDailySpendUsdg: this.config.fleetMaxDailySpendUsdg,
      realizedUsd: round(statuses.reduce((s, a) => s + a.realizedUsd, 0)),
      openValueUsd: round(statuses.reduce((s, a) => s + a.openValueUsd, 0)),
      equityUsd: round(statuses.reduce((s, a) => s + a.equityUsd, 0)),
      agents: this.agents.length,
      startedAt: this.startedAt,
    }
  }

  close(): void {
    this.stop()
    this.kill.dispose()
    this.journal.close()
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
