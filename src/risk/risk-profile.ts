/** The spec's exact $1,000 V1 risk profile — every field independently overridable via env. */
export interface AccountRiskProfile {
  accountLimitUsd: number
  maxPositionPct: number
  maxPositionUsd: number
  maxTotalExposurePct: number
  maxTotalExposureUsd: number
  maxOpenPositions: number
  maxDailyLossPct: number
  maxDailyLossUsd: number
  max7dDrawdownPct: number
  maxTotalDrawdownPct: number
  maxConsecutiveLosses: number
}

export const DEFAULT_RISK_PROFILE: AccountRiskProfile = {
  accountLimitUsd: 1000,
  maxPositionPct: 2.5,
  maxPositionUsd: 25,
  maxTotalExposurePct: 10,
  maxTotalExposureUsd: 100,
  maxOpenPositions: 4,
  maxDailyLossPct: 3,
  maxDailyLossUsd: 30,
  max7dDrawdownPct: 7,
  maxTotalDrawdownPct: 12,
  maxConsecutiveLosses: 5,
}

const ENV_KEYS: Record<keyof AccountRiskProfile, string> = {
  accountLimitUsd: 'ACCOUNT_LIMIT_USD',
  maxPositionPct: 'MAX_POSITION_PCT',
  maxPositionUsd: 'MAX_POSITION_USD',
  maxTotalExposurePct: 'MAX_TOTAL_EXPOSURE_PCT',
  maxTotalExposureUsd: 'MAX_TOTAL_EXPOSURE_USD',
  maxOpenPositions: 'MAX_OPEN_POSITIONS',
  maxDailyLossPct: 'MAX_DAILY_LOSS_PCT',
  maxDailyLossUsd: 'MAX_DAILY_LOSS_USD',
  max7dDrawdownPct: 'MAX_7D_DRAWDOWN_PCT',
  maxTotalDrawdownPct: 'MAX_TOTAL_DRAWDOWN_PCT',
  maxConsecutiveLosses: 'MAX_CONSECUTIVE_LOSSES',
}

export function loadRiskProfile(env: NodeJS.ProcessEnv = process.env): AccountRiskProfile {
  const profile = { ...DEFAULT_RISK_PROFILE }
  for (const key of Object.keys(ENV_KEYS) as (keyof AccountRiskProfile)[]) {
    const raw = env[ENV_KEYS[key]]
    if (raw === undefined || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`risk-profile: ${ENV_KEYS[key]}="${raw}" is not a non-negative number`)
    }
    profile[key] = n
  }
  return profile
}
