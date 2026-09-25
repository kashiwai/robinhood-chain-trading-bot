import { judgeFeatureVector, type JevVerdict, type LlmClientConfig } from '../framework/llm.js'
import type { FeatureVector } from './feature-vector.js'

export interface JevAdapterResult {
  verdict: JevVerdict | null
  /** ms the provider call actually took — part of Level 8's time-budget measurement. */
  latencyMs: number
  /** Populated only when the call failed — see the class doc comment on fail-closed. */
  error: string | null
}

/**
 * JEVをExecutionへ直接接続しない: this ONLY ever returns a verdict (or an
 * error) to whatever calls it (decision/ensemble.ts) — it has no reference
 * to a Market, an Executor, or a wallet, and cannot place an order no matter
 * what a model returns.
 *
 * Fail-closed is the whole point of the try/catch here: a JEV call that
 * times out, errors, or returns malformed JSON (see llm.ts's
 * parseJevVerdict) resolves `verdict: null` — never an implicit BUY, and
 * never silently treated as an implicit REJECT-with-full-confidence either;
 * callers must check `verdict === null` explicitly and decide their own
 * fallback (decision/ensemble.ts's rule-only fallback, when configured, or
 * simply not trading this mode's slice for this tick — see that file's doc
 * comment for the default when no fallback is configured).
 */
export class JevAdapter {
  constructor(private readonly cfg: LlmClientConfig) {}

  async judge(fv: FeatureVector): Promise<JevAdapterResult> {
    const started = Date.now()
    try {
      const verdict = await judgeFeatureVector(this.cfg, JSON.stringify(fv))
      return { verdict, latencyMs: Date.now() - started, error: null }
    } catch (err) {
      return {
        verdict: null,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
