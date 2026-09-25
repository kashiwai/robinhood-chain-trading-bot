export interface ExitTierConfig {
  /** Full exit if pnlPct falls to/below -stopLossPct. @defaultValue 0.12 (-12%) */
  stopLossPct: number
  /** First take-profit trigger. @defaultValue 0.20 (+20%) */
  tp1Pct: number
  /** Fraction of the ORIGINAL position size sold at TP1. @defaultValue 0.25 */
  tp1SellFraction: number
  /** Second take-profit trigger. @defaultValue 0.40 (+40%) */
  tp2Pct: number
  /** Fraction of the ORIGINAL position size sold at TP2 (additional, on top of TP1's). @defaultValue 0.25 */
  tp2SellFraction: number
  /** Once TP2 has fired, the remaining position exits if pnlPct drops this many percentage points below its post-TP2 peak. @defaultValue 0.15 */
  trailingStopPct: number
}

export const DEFAULT_EXIT_CONFIG: ExitTierConfig = {
  stopLossPct: 0.12,
  tp1Pct: 0.2,
  tp1SellFraction: 0.25,
  tp2Pct: 0.4,
  tp2SellFraction: 0.25,
  trailingStopPct: 0.15,
}

/** Persisted per-position across ticks (e.g. in `Position.meta` — see launch-sniper.ts). */
export interface ExitState {
  tp1Taken: boolean
  tp2Taken: boolean
  /** Highest pnlPct observed since TP2 fired — the trailing stop's reference point. Meaningless before TP2. */
  peakPnlPctSinceTp2: number
}

export const INITIAL_EXIT_STATE: ExitState = {
  tp1Taken: false,
  tp2Taken: false,
  peakPnlPctSinceTp2: -Infinity,
}

export interface ExitDecision {
  /** Fraction of the CURRENT (already-reduced-if-partially-sold) position to sell now. */
  sellFractionOfCurrent: number
  tier: 'stop_loss' | 'tp1' | 'tp2' | 'trailing_stop'
  reason: string
}

/**
 * The spec's exact tier ladder: -12% stop loss (full exit, from any state) /
 * +20% TP1 (sell 25% of the ORIGINAL size) / +40% TP2 (sell another 25% of
 * original) / the remaining 50% trails a 15-point stop from its post-TP2
 * peak. Pure and stateless per call — the caller persists `newState` (e.g.
 * into `Position.meta`) and passes it back in on the next tick.
 *
 * TP1/TP2 fractions are of the ORIGINAL position size, not of whatever
 * happens to remain when they fire — `soldFractionOfOriginal` (derived from
 * `state`) converts that into "sell X% of what's currently held", which is
 * what an Intent's `amountIn` actually needs (see launch-sniper.ts).
 */
export function evaluateExit(
  pnlPct: number,
  state: ExitState,
  config: ExitTierConfig = DEFAULT_EXIT_CONFIG,
): { decision: ExitDecision | null; newState: ExitState } {
  if (pnlPct <= -config.stopLossPct) {
    return {
      decision: {
        sellFractionOfCurrent: 1,
        tier: 'stop_loss',
        reason: `stop-loss ${(pnlPct * 100).toFixed(1)}%`,
      },
      newState: state,
    }
  }

  if (!state.tp1Taken && pnlPct >= config.tp1Pct) {
    const newState: ExitState = { ...state, tp1Taken: true }
    return {
      decision: {
        sellFractionOfCurrent: config.tp1SellFraction, // nothing sold yet -> fraction of current == fraction of original
        tier: 'tp1',
        reason: `take-profit-1 ${(pnlPct * 100).toFixed(1)}% — selling ${(config.tp1SellFraction * 100).toFixed(0)}% of original`,
      },
      newState,
    }
  }

  if (state.tp1Taken && !state.tp2Taken && pnlPct >= config.tp2Pct) {
    const newState: ExitState = { ...state, tp2Taken: true, peakPnlPctSinceTp2: pnlPct }
    const remainingFractionOfOriginal = 1 - config.tp1SellFraction
    const sellFractionOfCurrent =
      remainingFractionOfOriginal > 0 ? config.tp2SellFraction / remainingFractionOfOriginal : 1
    return {
      decision: {
        sellFractionOfCurrent: Math.min(1, sellFractionOfCurrent),
        tier: 'tp2',
        reason: `take-profit-2 ${(pnlPct * 100).toFixed(1)}% — selling ${(config.tp2SellFraction * 100).toFixed(0)}% of original`,
      },
      newState,
    }
  }

  if (state.tp2Taken) {
    const peak = Math.max(state.peakPnlPctSinceTp2, pnlPct)
    if (pnlPct <= peak - config.trailingStopPct) {
      return {
        decision: {
          sellFractionOfCurrent: 1,
          tier: 'trailing_stop',
          reason: `trailing-stop: ${(pnlPct * 100).toFixed(1)}% is ${(config.trailingStopPct * 100).toFixed(0)}pt below peak ${(peak * 100).toFixed(1)}%`,
        },
        newState: { ...state, peakPnlPctSinceTp2: peak },
      }
    }
    if (peak !== state.peakPnlPctSinceTp2) {
      return { decision: null, newState: { ...state, peakPnlPctSinceTp2: peak } }
    }
  }

  return { decision: null, newState: state }
}
