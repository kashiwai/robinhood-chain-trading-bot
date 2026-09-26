export type ProbeFailureClass = 'PERMANENT_TOKEN_FAILURE' | 'TEMPORARY_INFRA_FAILURE' | 'MARKET_FAILURE'

/**
 * Infrastructure noise — the probe attempt itself never got a real answer
 * from the token/pool, so it proves nothing about the token. Matched first:
 * an RPC timeout while quoting a thin pool must not be misread as "no
 * liquidity" (MARKET_FAILURE) just because the error text also mentions a
 * route.
 */
const INFRA_PATTERNS: RegExp[] = [
  /\btimed?[\s-]?out\b/i,
  /\btimeout\b/i,
  /\b429\b/i,
  /too many requests/i,
  /rate[\s-]?limit/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /disconnect/i,
  /provider unavailable/i,
  /network error/i,
  /fetch failed/i,
  /receipt wait/i,
]

/** The market simply doesn't support this trade size right now — not a statement about the token contract itself. */
const MARKET_PATTERNS: RegExp[] = [
  /no (buy|sell) route/i,
  /no liquid(ity)?/i,
  /insufficient liquidity/i,
  /price impact/i,
  /volatil/i,
]

/**
 * Classifies a probe's failure `reason` string (see execution/probe.ts) into
 * one of the spec's three buckets. Only `PERMANENT_TOKEN_FAILURE` results in
 * a permanent blacklist (see probe-store.ts) — everything else is a
 * quarantine-and-retry case. Defaults to `PERMANENT_TOKEN_FAILURE` for
 * anything that doesn't clearly match infra or market noise: the honeypot
 * signature ("cannot sell back"), an on-chain revert, a blacklist/tax/owner
 * restriction, or any other genuinely unexplained failure all fall here —
 * capital protection means treating an unrecognized failure as the token's
 * fault, not silently retrying a real rug forever.
 */
export function classifyProbeFailure(reason: string): ProbeFailureClass {
  if (INFRA_PATTERNS.some((p) => p.test(reason))) return 'TEMPORARY_INFRA_FAILURE'
  if (MARKET_PATTERNS.some((p) => p.test(reason))) return 'MARKET_FAILURE'
  return 'PERMANENT_TOKEN_FAILURE'
}
