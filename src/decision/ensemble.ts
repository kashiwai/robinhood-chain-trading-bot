import type { JevDecision } from '../framework/llm.js'
import type { FeatureVector } from './feature-vector.js'
import { ruleVerdict, type RuleThresholds, DEFAULT_RULE_THRESHOLDS } from './rules.js'
import { JevAdapter } from './jev-adapter.js'

export type DecisionMode = 'RULE' | 'JEV' | 'RULE_JEV' | 'JEV_SMART_WALLET' | 'JEV_SMART_WALLET_CLUSTER'

export const ALL_DECISION_MODES: readonly DecisionMode[] = [
  'RULE',
  'JEV',
  'RULE_JEV',
  'JEV_SMART_WALLET',
  'JEV_SMART_WALLET_CLUSTER',
]

export interface ModeResult {
  mode: DecisionMode
  decision: JevDecision
  confidence: number
  reasonCodes: string[]
}

export interface LatencyBudget {
  featureMs: number
  jevMs: number | null
  totalMs: number
}

export interface EnsembleResult {
  results: ModeResult[]
  liveMode: DecisionMode
  liveResult: ModeResult
  latency: LatencyBudget
  jevError: string | null
}

export interface EnsembleOptions {
  /** Which mode's verdict actually reaches the Risk Engine / Executor. Every mode still evaluates — see the class doc comment. */
  liveMode: DecisionMode
  /** `null` = JEV not configured at all (same as every call failing — see fail-closed below). */
  jevAdapter: JevAdapter | null
  ruleThresholds?: RuleThresholds
  /**
   * When the live mode needs JEV and JEV is unavailable/fails, an explicit
   * opt-in falls back to the RULE verdict instead of refusing outright — the
   * spec's "暗黙fallback禁止": this can NEVER happen silently, only when the
   * caller sets this flag deliberately.
   */
  explicitRuleOnlyFallback?: boolean
}

const JEV_DEPENDENT_MODES: ReadonlySet<DecisionMode> = new Set([
  'JEV',
  'RULE_JEV',
  'JEV_SMART_WALLET',
  'JEV_SMART_WALLET_CLUSTER',
])

/**
 * "同じSignalに同時評価" — every one of the spec's five decision modes runs
 * on the SAME feature vector every time, every tick. Only `liveMode`'s
 * result is ever handed to the risk engine / executor; the other four are
 * shadow-recorded (the caller's job — this just returns all five so nothing
 * downstream has to re-derive them, see decision/ensemble.test.ts's
 * "same replay dataset, compare strategies" acceptance case).
 *
 * Each mode after RULE_JEV requires STRICTLY MORE evidence than the last —
 * JEV_SMART_WALLET downgrades a BUY to WATCH with zero smart-wallet buyers;
 * JEV_SMART_WALLET_CLUSTER further downgrades unless at least 2 INDEPENDENT
 * entities (Level 4) are behind the buying, not one entity through several
 * wallets. A mode can only ever be as bullish as the mode before it, never
 * more.
 */
export async function evaluateEnsemble(fv: FeatureVector, opts: EnsembleOptions): Promise<EnsembleResult> {
  const startedTotal = Date.now()
  const featureStart = startedTotal // feature vector is already built by the caller; this class only measures the decision stage itself
  const rule = ruleVerdict(fv, opts.ruleThresholds ?? DEFAULT_RULE_THRESHOLDS)
  const ruleResult: ModeResult = {
    mode: 'RULE',
    decision: rule.decision,
    confidence: rule.confidence,
    reasonCodes: rule.reasonCodes,
  }
  const featureMs = Date.now() - featureStart

  let jevMs: number | null = null
  let jevError: string | null = null
  let jevVerdict: ModeResult | null = null
  if (opts.jevAdapter) {
    const jev = await opts.jevAdapter.judge(fv)
    jevMs = jev.latencyMs
    jevError = jev.error
    if (jev.verdict) {
      jevVerdict = {
        mode: 'JEV',
        decision: jev.verdict.decision,
        confidence: jev.verdict.confidence,
        reasonCodes: jev.verdict.reasonCodes,
      }
    }
  } else {
    jevError = 'jev adapter not configured'
  }
  const jevResult: ModeResult = jevVerdict ?? {
    mode: 'JEV',
    decision: 'REJECT',
    confidence: 0,
    reasonCodes: ['jev_unavailable'],
  }

  const ruleJevResult = combine('RULE_JEV', ruleResult, jevResult, jevVerdict !== null)
  const smartWalletResult = downgradeWithoutEvidence(
    'JEV_SMART_WALLET',
    ruleJevResult,
    fv.smart_wallet_count >= 1,
    'no_smart_money',
  )
  const clusterResult = downgradeWithoutEvidence(
    'JEV_SMART_WALLET_CLUSTER',
    smartWalletResult,
    fv.independent_wallet_count >= 2,
    'cluster_coordinated',
  )

  const results = [ruleResult, jevResult, ruleJevResult, smartWalletResult, clusterResult]
  const totalMs = Date.now() - startedTotal

  let liveResult = results.find((r) => r.mode === opts.liveMode)!
  if (JEV_DEPENDENT_MODES.has(opts.liveMode) && jevVerdict === null) {
    liveResult = opts.explicitRuleOnlyFallback
      ? { ...ruleResult, reasonCodes: [...ruleResult.reasonCodes, 'jev_unavailable_rule_fallback'] }
      : {
          mode: opts.liveMode,
          decision: 'REJECT',
          confidence: 0,
          reasonCodes: ['jev_unavailable_fail_closed'],
        }
  }

  return { results, liveMode: opts.liveMode, liveResult, latency: { featureMs, jevMs, totalMs }, jevError }
}

function combine(mode: DecisionMode, a: ModeResult, b: ModeResult, jevAvailable: boolean): ModeResult {
  const reasonCodes = [...new Set([...a.reasonCodes, ...b.reasonCodes])]
  if (!jevAvailable)
    return { mode, decision: 'REJECT', confidence: 0, reasonCodes: [...reasonCodes, 'jev_unavailable'] }
  if (a.decision === 'REJECT' || b.decision === 'REJECT')
    return { mode, decision: 'REJECT', confidence: Math.max(a.confidence, b.confidence), reasonCodes }
  const decision: JevDecision = a.decision === 'BUY' && b.decision === 'BUY' ? 'BUY' : 'WATCH'
  return { mode, decision, confidence: (a.confidence + b.confidence) / 2, reasonCodes }
}

/** Downgrades a BUY to WATCH (never upgrades) when `hasEvidence` is false — never more bullish than the mode it's derived from. */
function downgradeWithoutEvidence(
  mode: DecisionMode,
  from: ModeResult,
  hasEvidence: boolean,
  missingCode: string,
): ModeResult {
  if (from.decision !== 'BUY' || hasEvidence) {
    return { ...from, mode }
  }
  return {
    mode,
    decision: 'WATCH',
    confidence: from.confidence * 0.5,
    reasonCodes: [...from.reasonCodes, missingCode],
  }
}
