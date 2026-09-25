import type { PerformanceReport } from './performance.js'

export interface OptimizationSuggestion {
  parameter: string
  currentValue: number
  suggestedValue: number
  beforePerformance: Pick<PerformanceReport, 'winRate' | 'expectancyUsd' | 'profitFactor' | 'totalTrades'>
  /** What actually changed between the before/after performance snapshots this suggestion was derived from. */
  expectedImpact: string
  /** 0-1 — see the function doc comment on how this is derived; NOT a promise, a sample-size-aware caveat. */
  confidence: number
}

/**
 * "AIは提案のみ...人間承認後に変更" — this module NEVER writes a config
 * value anywhere; it has no reference to risk-profile.ts, exit-engine.ts,
 * or any live config object, on purpose. It only ever produces a data
 * object a human reads and decides on. There is deliberately no
 * `applySuggestion()` function anywhere in this codebase.
 *
 * `beforePerformance`/`expectedImpact` are computed from two REAL,
 * caller-supplied {@link PerformanceReport}s — one for the current
 * parameter value, one for a candidate alternative (e.g. re-running
 * computePerformance() over the same trade history with a stricter filter
 * applied) — never invented deltas. `confidence` is deliberately just the
 * smaller of the two report's trade-count ratio against a target sample
 * size: a suggestion backed by 15 trades is flagged low-confidence
 * regardless of how good the delta looks, the same principle
 * wallet-score.ts's `confidence()` already applies to wallet reputation.
 */
export function suggestParameterChange(
  parameter: string,
  currentValue: number,
  suggestedValue: number,
  beforePerformance: PerformanceReport,
  afterPerformance: PerformanceReport,
  minSampleSizeForFullConfidence = 100,
): OptimizationSuggestion {
  const impacts: string[] = []
  const winRateDelta = afterPerformance.winRate - beforePerformance.winRate
  const expectancyDelta = afterPerformance.expectancyUsd - beforePerformance.expectancyUsd
  if (Math.abs(winRateDelta) >= 0.005) {
    impacts.push(`win rate ${winRateDelta >= 0 ? '+' : ''}${(winRateDelta * 100).toFixed(1)}pt`)
  }
  if (Math.abs(expectancyDelta) >= 0.01) {
    impacts.push(
      `expectancy ${expectancyDelta >= 0 ? `+$${expectancyDelta.toFixed(2)}` : `-$${Math.abs(expectancyDelta).toFixed(2)}`}/trade`,
    )
  }
  const pfDelta = afterPerformance.profitFactor - beforePerformance.profitFactor
  if (Number.isFinite(pfDelta) && Math.abs(pfDelta) >= 0.05) {
    impacts.push(`profit factor ${pfDelta >= 0 ? '+' : ''}${pfDelta.toFixed(2)}`)
  }

  const smallerSampleRatio =
    Math.min(beforePerformance.totalTrades, afterPerformance.totalTrades) / minSampleSizeForFullConfidence
  const confidence = Math.max(0, Math.min(1, smallerSampleRatio))

  return {
    parameter,
    currentValue,
    suggestedValue,
    beforePerformance: {
      winRate: beforePerformance.winRate,
      expectancyUsd: beforePerformance.expectancyUsd,
      profitFactor: beforePerformance.profitFactor,
      totalTrades: beforePerformance.totalTrades,
    },
    expectedImpact: impacts.length > 0 ? impacts.join(', ') : 'no material difference detected',
    confidence,
  }
}
