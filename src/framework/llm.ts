/**
 * Multi-provider LLM client for {@link LlmStrategist}. Bring your own key: the
 * operator picks exactly one of Anthropic Claude, OpenAI, Groq, or OpenRouter
 * via env config (see {@link loadLlmConfig} in ./config.js) and this module
 * speaks that provider's HTTP API directly with `fetch` — no SDK dependency,
 * matching the rest of this package (better-sqlite3, hoodchain, viem, ws are
 * the only runtime deps).
 *
 * The verdict contract is strict on purpose: a strategy that trades real money
 * must never trust free-text from an LLM. Every provider is prompted to return
 * ONLY a JSON object; the response is parsed with a tolerant extractor (finds
 * the first `{...}` blob, so a model that wraps the JSON in a sentence still
 * works) and validated field-by-field. A malformed or missing verdict throws —
 * the caller (LlmStrategist.tick) treats that as "skip this candidate, alert",
 * never as an implicit buy or an implicit skip-silently.
 */

export type LlmProvider = 'anthropic' | 'openai' | 'groq' | 'openrouter'

export interface LlmClientConfig {
  provider: LlmProvider
  apiKey: string
  /** Falls back to a sane per-provider default (see {@link DEFAULT_MODELS}) when unset. */
  model?: string
  /** Abort the request after this many ms. Default 9000. */
  timeoutMs?: number
}

export interface LlmVerdict {
  buy: boolean
  /** Clamped to [0, 1]. */
  confidence: number
  thesis: string
}

/**
 * Level 8's JEV output contract — deliberately NOT {@link LlmVerdict}. The
 * spec is explicit: "自然言語長文は禁止" (no long-form natural language) and
 * "Low latency最優先". `reasonCodes` are short machine tokens (e.g.
 * `"low_liquidity"`, `"clean_contract"`), not a sentence — see
 * `JEV_REASON_CODES` for the fixed vocabulary this is validated against, so
 * a downstream consumer can switch on them instead of parsing prose.
 */
export type JevDecision = 'BUY' | 'REJECT' | 'WATCH'

export interface JevVerdict {
  decision: JevDecision
  /** Clamped to [0, 1]. */
  confidence: number
  reasonCodes: string[]
}

/** Fixed vocabulary `judgeFeatureVector` prompts the model to choose from — keeps reason codes machine-parseable and comparable across calls. */
export const JEV_REASON_CODES = [
  'clean_contract',
  'contract_risk',
  'deep_liquidity',
  'shallow_liquidity',
  'high_sellability',
  'low_sellability',
  'smart_money_buying',
  'no_smart_money',
  'cluster_coordinated',
  'independent_buyers',
  'strong_momentum',
  'weak_momentum',
  'buy_pressure',
  'sell_pressure',
  'young_token',
  'stale_token',
] as const

/**
 * Default model per provider. Anthropic and OpenRouter defaults are stable
 * (a dated snapshot and an auto-router, respectively). OpenAI/Groq model
 * catalogs move faster — `HOOD_LLM_MODEL` overrides any of these; if a default
 * ever goes stale the provider call fails with a clear "check HOOD_LLM_MODEL"
 * error (see {@link callProvider}) rather than a silent misroute.
 */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
}

const SYSTEM_PROMPT = [
  'You are a risk-averse trading analyst judging a brand-new token launch on Robinhood Chain,',
  'a 24/7 permissionless DEX environment where most launches are worthless or scams.',
  'You will be given real on-chain facts about one launch: its launchpad, whether a buy-then-sell',
  'round trip retains value (a honeypot signal), and what fraction of supply the deployer wallet',
  'still holds (a rug-risk signal). You have no access to socials, team identity, or any off-chain',
  'information — judge only from what is given.',
  '',
  'Reply with ONLY a single JSON object, no prose before or after it, matching exactly:',
  '{"buy": boolean, "confidence": number between 0 and 1, "thesis": "one sentence"}',
  '',
  '"buy" should be true only when the facts given suggest this is unusually clean for a brand-new',
  'launch (high retention, low deployer concentration) — most launches should get buy:false.',
  '"confidence" reflects how sure you are in that judgment given how thin the available signal is.',
].join('\n')

/** Ask the configured LLM to judge a launch brief. Throws on any failure (timeout, HTTP error, malformed verdict). */
export async function judgeLaunch(cfg: LlmClientConfig, brief: string): Promise<LlmVerdict> {
  const text = await callWithTimeout(cfg, SYSTEM_PROMPT, brief)
  return parseVerdict(text)
}

/**
 * Level 8's JEV adapter entry point: judges a pre-built, already-numeric
 * feature vector (see decision/feature-vector.ts) and returns a structured
 * {@link JevVerdict} — no free-text brief, no thesis. `featureVectorJson`
 * is the caller's serialized vector (kept as a plain string here so this
 * module stays decision-schema-agnostic; decision/jev-adapter.ts owns the
 * schema).
 */
export async function judgeFeatureVector(
  cfg: LlmClientConfig,
  featureVectorJson: string,
): Promise<JevVerdict> {
  const text = await callWithTimeout(cfg, JEV_SYSTEM_PROMPT, featureVectorJson)
  return parseJevVerdict(text)
}

async function callWithTimeout(
  cfg: LlmClientConfig,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const model = cfg.model || DEFAULT_MODELS[cfg.provider]
  const timeoutMs = cfg.timeoutMs ?? 9000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await callProvider(cfg.provider, cfg.apiKey, model, systemPrompt, userContent, controller.signal)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`hood-traders llm.ts: ${cfg.provider} request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function callProvider(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  signal: AbortSignal,
): Promise<string> {
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    })
    const body = await res.text()
    if (!res.ok) throw providerError('anthropic', model, res.status, body)
    const data = JSON.parse(body) as { content?: { text?: string }[] }
    const text = data.content?.[0]?.text
    if (!text)
      throw new Error(`hood-traders llm.ts: anthropic response had no content text: ${body.slice(0, 300)}`)
    return text
  }

  // openai, groq, and openrouter all speak the OpenAI chat-completions shape.
  const { url, extraHeaders } = openAiCompatibleEndpoint(provider)
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  })
  const body = await res.text()
  if (!res.ok) throw providerError(provider, model, res.status, body)
  const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] }
  const text = data.choices?.[0]?.message?.content
  if (!text)
    throw new Error(`hood-traders llm.ts: ${provider} response had no message content: ${body.slice(0, 300)}`)
  return text
}

function openAiCompatibleEndpoint(provider: 'openai' | 'groq' | 'openrouter'): {
  url: string
  extraHeaders: Record<string, string>
} {
  switch (provider) {
    case 'openai':
      return { url: 'https://api.openai.com/v1/chat/completions', extraHeaders: {} }
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/chat/completions', extraHeaders: {} }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        extraHeaders: {
          'HTTP-Referer': 'https://github.com/nirholas/hood-traders',
          'X-Title': 'hood-traders',
        },
      }
  }
}

function providerError(provider: LlmProvider, model: string, status: number, body: string): Error {
  return new Error(
    `hood-traders llm.ts: ${provider} rejected request (HTTP ${status}, model="${model}"). ` +
      `If this is a model-not-found error, set HOOD_LLM_MODEL to a current model id for this provider. ` +
      `Response: ${body.slice(0, 300)}`,
  )
}

/** Extract the first `{...}` blob from `text` and validate it as an {@link LlmVerdict}. Throws on any mismatch. */
export function parseVerdict(text: string): LlmVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match)
    throw new Error(`hood-traders llm.ts: no JSON object found in LLM response: ${text.slice(0, 300)}`)
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch (err) {
    throw new Error(`hood-traders llm.ts: LLM response JSON did not parse: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('hood-traders llm.ts: LLM verdict was not a JSON object')
  }
  const v = raw as Record<string, unknown>
  if (typeof v.buy !== 'boolean') {
    throw new Error(`hood-traders llm.ts: LLM verdict missing boolean "buy": ${JSON.stringify(v)}`)
  }
  if (typeof v.thesis !== 'string' || v.thesis.trim().length === 0) {
    throw new Error(`hood-traders llm.ts: LLM verdict missing non-empty "thesis": ${JSON.stringify(v)}`)
  }
  const confidenceRaw = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence)
  if (!Number.isFinite(confidenceRaw)) {
    throw new Error(`hood-traders llm.ts: LLM verdict has non-numeric "confidence": ${JSON.stringify(v)}`)
  }
  const confidence = Math.min(1, Math.max(0, confidenceRaw))
  return { buy: v.buy, confidence, thesis: v.thesis.trim() }
}

const JEV_SYSTEM_PROMPT = [
  'You are a low-latency trading signal judge for brand-new token launches on Robinhood Chain.',
  'You will receive ONE JSON object: a numeric feature vector, already computed from real on-chain',
  'data (liquidity depth, contract risk score, sellability, smart-wallet buying activity, cluster',
  'coordination, momentum). You have no other context — do not invent facts not in the vector.',
  '',
  `Reply with ONLY a single JSON object, no prose before or after it, no explanation sentence,`,
  'matching exactly:',
  '{"decision": "BUY" | "REJECT" | "WATCH", "confidence": number between 0 and 1, "reason_codes": string[]}',
  '',
  `"reason_codes" MUST be chosen only from this fixed list (use 1-4 of them, the ones that actually`,
  `drove your decision): ${JEV_REASON_CODES.join(', ')}.`,
  'Never return a sentence, an explanation, or a code not in that list.',
  '"BUY" should be rare — most launches should get REJECT or WATCH. "WATCH" means promising but not',
  'yet confident enough to trade.',
].join('\n')

/** Extract the first `{...}` blob from `text` and validate it as a {@link JevVerdict}. Throws on any mismatch. */
export function parseJevVerdict(text: string): JevVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match)
    throw new Error(`hood-traders llm.ts: no JSON object found in JEV response: ${text.slice(0, 300)}`)
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch (err) {
    throw new Error(`hood-traders llm.ts: JEV response JSON did not parse: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('hood-traders llm.ts: JEV verdict was not a JSON object')
  }
  const v = raw as Record<string, unknown>
  if (v.decision !== 'BUY' && v.decision !== 'REJECT' && v.decision !== 'WATCH') {
    throw new Error(`hood-traders llm.ts: JEV verdict has invalid "decision": ${JSON.stringify(v)}`)
  }
  const confidenceRaw = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence)
  if (!Number.isFinite(confidenceRaw)) {
    throw new Error(`hood-traders llm.ts: JEV verdict has non-numeric "confidence": ${JSON.stringify(v)}`)
  }
  if (!Array.isArray(v.reason_codes) || !v.reason_codes.every((c) => typeof c === 'string')) {
    throw new Error(`hood-traders llm.ts: JEV verdict missing string[] "reason_codes": ${JSON.stringify(v)}`)
  }
  const known = new Set<string>(JEV_REASON_CODES)
  const reasonCodes = (v.reason_codes as string[]).filter((c) => known.has(c))
  return { decision: v.decision, confidence: Math.min(1, Math.max(0, confidenceRaw)), reasonCodes }
}
