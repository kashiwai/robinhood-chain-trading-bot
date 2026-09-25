import type { DecisionMode } from '../decision/ensemble.js'
import type { JevDecision } from '../framework/llm.js'

export interface StrategySample {
  mode: DecisionMode
  decision: JevDecision
  confidence: number
  /**
   * Realized PnL for this candidate, ONLY when it's actually known — i.e.
   * this candidate was genuinely traded (by whichever mode was live at the
   * time) and the position has since closed. `null` for every shadow mode's
   * verdict on a candidate nothing ever traded — there is no simulated
   * "what the fill would have been" here; see the module doc comment.
   */
  realizedPnlUsd: number | null
}

export interface StrategyModeSummary {
  mode: DecisionMode
  totalSamples: number
  buyCount: number
  watchCount: number
  rejectCount: number
  buyRate: number
  meanConfidence: number
  /** Samples where this mode said BUY and we also know the real outcome. */
  samplesWithKnownBuyOutcome: number
  /** Average realized PnL across exactly those known-outcome BUY samples — null if there are none. */
  avgRealizedPnlWhenBuy: number | null
}

/**
 * "同じreplay datasetで各strategyを比較可能" — groups a set of
 * {@link StrategySample}s (one per decision mode per candidate, as produced
 * by decision/ensemble.ts and journaled alongside whatever the live mode
 * actually did) by mode and summarizes each.
 *
 * Deliberately does NOT attempt a full backtest PnL for every shadow mode —
 * that would need simulating a fill for a candidate the live strategy never
 * actually bought, which needs a price-path replay engine this codebase
 * doesn't have. What IS real here: decision-rate statistics (how often each
 * mode says BUY, at what confidence) across the whole sample, plus realized
 * PnL specifically for the subset where a candidate WAS actually traded (by
 * whichever mode was live) and the outcome is known — letting you ask "when
 * JEV_SMART_WALLET_CLUSTER also said BUY on a candidate we traded, how did
 * those trades do?" without inventing outcomes for the ones nothing traded.
 */
export function compareStrategies(samples: readonly StrategySample[]): StrategyModeSummary[] {
  const byMode = new Map<DecisionMode, StrategySample[]>()
  for (const s of samples) {
    const list = byMode.get(s.mode) ?? []
    list.push(s)
    byMode.set(s.mode, list)
  }

  const summaries: StrategyModeSummary[] = []
  for (const [mode, list] of byMode) {
    const buys = list.filter((s) => s.decision === 'BUY')
    const watches = list.filter((s) => s.decision === 'WATCH')
    const rejects = list.filter((s) => s.decision === 'REJECT')
    const knownBuyOutcomes = buys.filter((s) => s.realizedPnlUsd !== null)
    const meanConfidence = list.length > 0 ? list.reduce((sum, s) => sum + s.confidence, 0) / list.length : 0

    summaries.push({
      mode,
      totalSamples: list.length,
      buyCount: buys.length,
      watchCount: watches.length,
      rejectCount: rejects.length,
      buyRate: list.length > 0 ? buys.length / list.length : 0,
      meanConfidence,
      samplesWithKnownBuyOutcome: knownBuyOutcomes.length,
      avgRealizedPnlWhenBuy:
        knownBuyOutcomes.length > 0
          ? knownBuyOutcomes.reduce((sum, s) => sum + (s.realizedPnlUsd ?? 0), 0) / knownBuyOutcomes.length
          : null,
    })
  }
  return summaries
}
