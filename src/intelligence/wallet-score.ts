import type { WalletStatsRow } from './wallet-store.js'

/**
 * Component weights for the 0-100 wallet score. This is explicitly the
 * spec's "初期案" (initial draft) — the exact formula behind each component
 * is a documented, reasonable starting heuristic, not a backtested model
 * (there is no historical ground truth to backtest against yet). Override
 * via `loadWalletScoreWeights` from `HOOD_WALLET_SCORE_WEIGHTS_JSON` (or
 * pass a partial object directly) rather than editing this file.
 */
export interface WalletScoreWeights {
  realizedPnl: number
  profitFactor: number
  winRate: number
  earlyEntry: number
  rugAvoidance: number
  consistency: number
  sampleConfidence: number
}

export const DEFAULT_WEIGHTS: WalletScoreWeights = {
  realizedPnl: 25,
  profitFactor: 20,
  winRate: 15,
  earlyEntry: 15,
  rugAvoidance: 10,
  consistency: 10,
  sampleConfidence: 5,
}

/** Reference scales each normalized-to-[0,1] component is measured against. Also overridable. */
export interface WalletScoreScales {
  /** Realized PnL (USD) that earns full marks on the realizedPnl component. */
  realizedPnlFullMarkUsd: number
  /** Profit factor that earns full marks on the profitFactor component. */
  profitFactorFullMark: number
  /** Trade count at which {@link confidence} reaches 1.0. */
  confidenceSampleTarget: number
}

export const DEFAULT_SCALES: WalletScoreScales = {
  realizedPnlFullMarkUsd: 5_000,
  profitFactorFullMark: 3,
  confidenceSampleTarget: 50,
}

export function loadWalletScoreWeights(env: NodeJS.ProcessEnv = process.env): WalletScoreWeights {
  const raw = env.HOOD_WALLET_SCORE_WEIGHTS_JSON
  if (!raw) return DEFAULT_WEIGHTS
  const parsed = JSON.parse(raw) as Partial<WalletScoreWeights>
  return { ...DEFAULT_WEIGHTS, ...parsed }
}

/**
 * Confidence (0-1) that `score` reflects real skill rather than a small
 * sample's noise. A 10-trade wallet and a 500-trade wallet are never scored
 * with the same confidence — see wallet-store.ts's `total_trades`.
 */
export function confidence(totalTrades: number, scales: WalletScoreScales = DEFAULT_SCALES): number {
  return Math.max(0, Math.min(1, totalTrades / scales.confidenceSampleTarget))
}

/**
 * Coefficient-of-variation-based consistency: a wallet whose wins and losses
 * are similar in size (win/loss ratio close to 1, in either direction) reads
 * as more consistent than one with occasional huge wins offsetting frequent
 * small losses (or vice versa) — a streaky, less repeatable pattern. Clamped
 * to [0, 1]; undefined (no losses yet, or no trades at all) returns 0.5, a
 * neutral midpoint rather than a fabricated extreme.
 */
function consistencyComponent(stats: WalletStatsRow): number {
  if (stats.winningTrades === 0 || stats.losingTrades === 0) return 0.5
  const ratio = stats.avgWin / stats.avgLoss
  const skew = Math.abs(Math.log(ratio)) // 0 when avgWin === avgLoss, grows either direction
  return Math.max(0, 1 - skew / 2) // skew of 2 log-units (≈7.4x either way) or more -> 0
}

export interface WalletScoreResult {
  score: number
  confidence: number
  components: Record<keyof WalletScoreWeights, number> // each already weighted (0..weight)
}

export function computeWalletScore(
  stats: WalletStatsRow,
  weights: WalletScoreWeights = DEFAULT_WEIGHTS,
  scales: WalletScoreScales = DEFAULT_SCALES,
): WalletScoreResult {
  const conf = confidence(stats.totalTrades, scales)

  const realizedPnlNorm = clamp01(stats.realizedPnlUsd / scales.realizedPnlFullMarkUsd)
  const profitFactorNorm = Number.isFinite(stats.profitFactor)
    ? clamp01(stats.profitFactor / scales.profitFactorFullMark)
    : stats.winningTrades > 0
      ? 1
      : 0
  const winRateNorm = clamp01(stats.winRate)
  const earlyEntryNorm = clamp01(stats.earlyEntryScore ?? 0)
  const rugAvoidanceNorm = clamp01(1 - stats.rugExposure)
  const consistencyNorm = clamp01(consistencyComponent(stats))

  const components: Record<keyof WalletScoreWeights, number> = {
    realizedPnl: realizedPnlNorm * weights.realizedPnl,
    profitFactor: profitFactorNorm * weights.profitFactor,
    winRate: winRateNorm * weights.winRate,
    earlyEntry: earlyEntryNorm * weights.earlyEntry,
    rugAvoidance: rugAvoidanceNorm * weights.rugAvoidance,
    consistency: consistencyNorm * weights.consistency,
    sampleConfidence: conf * weights.sampleConfidence,
  }

  const score = Object.values(components).reduce((a, b) => a + b, 0)
  return { score: clamp(score, 0, 100), confidence: conf, components }
}

function clamp01(n: number): number {
  return clamp(n, 0, 1)
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
