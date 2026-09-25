import type { AccountRiskProfile } from './risk-profile.js'

export interface AccountRiskContext {
  /** Number of currently open positions across the whole fleet (before this buy). */
  openPositionsCount: number
  /** USD value of every open position summed, before this buy. */
  totalExposureUsd: number
  /** USD notional this candidate buy would add. */
  candidatePositionUsd: number
  /** Realized loss today (UTC), as a positive USD magnitude. 0 if flat or net positive. */
  dailyRealizedLossUsd: number
  /** Drawdown from the trailing-7-day equity peak, as a positive percentage (7 = 7%). */
  drawdown7dPct: number
  /** Drawdown from the all-time equity peak, as a positive percentage. */
  totalDrawdownPct: number
  /** Consecutive losing trades immediately preceding this one (fleet-wide). */
  consecutiveLosses: number
}

export type AccountRiskReason =
  | 'account_position_cap'
  | 'account_exposure_cap'
  | 'account_open_positions_cap'
  | 'account_daily_loss_limit'
  | 'account_7d_drawdown_limit'
  | 'account_total_drawdown_limit'
  | 'account_consecutive_losses'

export interface AccountRiskVerdict {
  ok: boolean
  reason?: AccountRiskReason
  detail: string
}

/**
 * Account-wide (fleet-wide) risk gate — sits ABOVE the existing per-agent
 * {@link ../framework/risk.js!RiskEngine}, which only ever sees one agent's
 * own spend/position numbers. This is the $1,000 V1 profile's actual
 * ceilings: total exposure, open position count, daily loss, 7-day and
 * all-time drawdown, and a consecutive-loss streak — none of which a single
 * agent can see on its own. Exempts sells for the same reason RiskEngine
 * does: these caps bound how much risk gets taken ON, and refusing a
 * de-risking sell because of them would trap a position instead of letting
 * it close.
 */
export function checkAccountRisk(ctx: AccountRiskContext, profile: AccountRiskProfile): AccountRiskVerdict {
  const positionCapUsd = Math.min(
    profile.maxPositionUsd,
    (profile.maxPositionPct / 100) * profile.accountLimitUsd,
  )
  if (ctx.candidatePositionUsd > positionCapUsd) {
    return {
      ok: false,
      reason: 'account_position_cap',
      detail: `position $${ctx.candidatePositionUsd.toFixed(2)} exceeds cap $${positionCapUsd.toFixed(2)}`,
    }
  }

  const exposureCapUsd = Math.min(
    profile.maxTotalExposureUsd,
    (profile.maxTotalExposurePct / 100) * profile.accountLimitUsd,
  )
  const exposureAfter = ctx.totalExposureUsd + ctx.candidatePositionUsd
  if (exposureAfter > exposureCapUsd) {
    return {
      ok: false,
      reason: 'account_exposure_cap',
      detail: `total exposure would reach $${exposureAfter.toFixed(2)}, over cap $${exposureCapUsd.toFixed(2)}`,
    }
  }

  if (ctx.openPositionsCount >= profile.maxOpenPositions) {
    return {
      ok: false,
      reason: 'account_open_positions_cap',
      detail: `${ctx.openPositionsCount} open positions already at the cap of ${profile.maxOpenPositions}`,
    }
  }

  const dailyLossCapUsd = Math.min(
    profile.maxDailyLossUsd,
    (profile.maxDailyLossPct / 100) * profile.accountLimitUsd,
  )
  if (ctx.dailyRealizedLossUsd >= dailyLossCapUsd) {
    return {
      ok: false,
      reason: 'account_daily_loss_limit',
      detail: `today's realized loss $${ctx.dailyRealizedLossUsd.toFixed(2)} has reached the daily cap $${dailyLossCapUsd.toFixed(2)}`,
    }
  }

  if (ctx.drawdown7dPct >= profile.max7dDrawdownPct) {
    return {
      ok: false,
      reason: 'account_7d_drawdown_limit',
      detail: `7-day drawdown ${ctx.drawdown7dPct.toFixed(1)}% has reached the cap ${profile.max7dDrawdownPct}%`,
    }
  }

  if (ctx.totalDrawdownPct >= profile.maxTotalDrawdownPct) {
    return {
      ok: false,
      reason: 'account_total_drawdown_limit',
      detail: `total drawdown ${ctx.totalDrawdownPct.toFixed(1)}% has reached the cap ${profile.maxTotalDrawdownPct}%`,
    }
  }

  if (ctx.consecutiveLosses >= profile.maxConsecutiveLosses) {
    return {
      ok: false,
      reason: 'account_consecutive_losses',
      detail: `${ctx.consecutiveLosses} consecutive losses has reached the cap ${profile.maxConsecutiveLosses}`,
    }
  }

  return { ok: true, detail: 'within account risk profile' }
}
