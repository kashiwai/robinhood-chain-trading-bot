import type { FeatureVector } from '../decision/feature-vector.js'
import type { EnsembleResult } from '../decision/ensemble.js'
import type { ProbeResult } from '../execution/probe.js'
import type { OrderRow } from '../execution/order-store.js'

/**
 * Everything the spec's Level 9 wants attached to a trade — signal, every
 * feature, every model decision, wallet/cluster signals, quotes/
 * simulations, probe results, the submitted tx, the actual fill, exit
 * reason, PnL/fees/gas/slippage/latency — as ONE typed record. Assigned
 * wholesale into `TradeRecord.meta` (already a free-form JSON blob — see
 * framework/types.ts), so nothing about the existing journal schema needs
 * to change to carry it.
 *
 * Every field is optional because not every trade has every kind of data —
 * a paper-mode trade has no OrderRow (Level 6 only runs live); a trade from
 * before Level 8 was wired has no EnsembleResult. `null`/absent means
 * "not available for this trade", never a fabricated placeholder.
 */
export interface EnrichedTradeMeta {
  /** What triggered this trade — a discovery event ID, a strategy name, or similar caller-supplied identifier. */
  signal?: string
  featureVector?: FeatureVector
  decision?: EnsembleResult
  probe?: ProbeResult
  order?: OrderRow
  exitReason?: string
  /** ms from signal detection to order submission — Level 8's time-budget measurement, carried through to the journal. */
  latencyMs?: number
}

/** Merges enrichment data into whatever meta a caller already has (e.g. an Intent's own `meta`), never dropping existing keys. */
export function buildEnrichedTradeMeta(
  base: Record<string, unknown>,
  enrichment: EnrichedTradeMeta,
): Record<string, unknown> {
  return { ...base, ...enrichment }
}
