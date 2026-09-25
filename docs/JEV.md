# JEV — the LLM Judge

"JEV" is this codebase's name for the LLM-as-judge component (`src/framework/llm.ts`,
`src/decision/jev-adapter.ts`). It reads signals and returns a structured opinion. **It never
holds a private key, never calls `Executor.execute()`, and never bypasses a risk gate** — see
`docs/SECURITY.md`'s "Privilege separation" section for the structural guarantee, not just a
policy statement.

## Contract

`judgeFeatureVector(cfg, featureVectorJson)` sends the Level 8 `FeatureVector`
(`src/decision/feature-vector.ts`) to the configured provider and parses a `JevVerdict`:

```ts
interface JevVerdict {
  verdict: 'buy' | 'reject' | 'watch'
  confidence: number // 0-1
  reasonCodes: string[] // from a fixed 16-code vocabulary, JEV_REASON_CODES
}
```

`parseJevVerdict()` rejects anything that doesn't parse into this exact shape — a malformed LLM
response is a parse failure, not a best-effort partial read.

## Fail-closed, always

`JevAdapter.judge()` (`src/decision/jev-adapter.ts`) never throws — any error (timeout, malformed
response, provider outage) resolves `{verdict: null, latencyMs, error}`. `evaluateEnsemble()`
(`src/decision/ensemble.ts`) treats a `null` verdict as **no signal**, never an implicit BUY:

- In a JEV-dependent mode (`JEV_ONLY`, `JEV_SMART_WALLET`, `JEV_SMART_WALLET_CLUSTER`) with no
  `explicitRuleOnlyFallback` set, an unavailable JEV verdict resolves `REJECT` with reason code
  `jev_unavailable_fail_closed`.
- Only with `explicitRuleOnlyFallback: true` set explicitly does it fall back to the rule-only
  verdict, tagged `jev_unavailable_rule_fallback` — an opt-in degrade, never a silent default.

## The 5-mode ensemble

`evaluateEnsemble()` runs all five modes on every call — `RULE`, `RULE_JEV`, `JEV_ONLY`,
`JEV_SMART_WALLET`, `JEV_SMART_WALLET_CLUSTER` — and `downgradeWithoutEvidence()` enforces that the
wallet-intelligence-aware modes (`JEV_SMART_WALLET`/`_CLUSTER`) can only be as-or-less bullish than
`RULE_JEV`, never more bullish just because a stronger mode ran. `RULE` mode's own BUY threshold
depends only on Level 5 signal margins (contract risk / sellability / liquidity), deliberately
without a wallet-evidence requirement — the wallet-evidence gate lives exclusively in the
`JEV_SMART_WALLET*` modes, so the mode ladder's escalating strictness is real and testable rather
than every mode secretly requiring the same evidence.

## Confidence threshold

`loadLlmMinConfidence()` (default 0.6, `HOOD_LLM_MIN_CONFIDENCE`) is the minimum stated confidence
required to convert a JEV `buy` verdict into an actual trade in `llm-strategist.ts` — a
low-confidence buy verdict is treated the same as a `watch`.

## Scope boundary

The full candidate-evaluator → ensemble pipeline is built and unit-tested
(`src/decision/candidate-evaluator.ts`, `tests/unit/ensemble.test.ts`,
`tests/unit/candidate-evaluator.test.ts`) but is **not called from `launch-sniper.ts`'s live
decision path** — only `llm-strategist.ts` (a separate, simpler strategy using the older
`judgeLaunch`/`LlmVerdict` contract) is wired into the running fleet today. This is documented
here, in the module doc comments, and in `docs/ARCHITECTURE.md` — not a claimed-but-missing
feature.
