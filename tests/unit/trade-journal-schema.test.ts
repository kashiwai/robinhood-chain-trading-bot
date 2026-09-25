import { describe, expect, it } from 'vitest'
import { buildEnrichedTradeMeta } from '../../src/analytics/trade-journal-schema.js'

describe('buildEnrichedTradeMeta', () => {
  it('merges enrichment fields into an existing meta object without dropping the originals', () => {
    const base = { launchpad: 'noxa', deployerPct: 0.05 }
    const merged = buildEnrichedTradeMeta(base, {
      signal: 'evt-123',
      exitReason: 'take-profit-1',
      latencyMs: 850,
    })
    expect(merged).toEqual({
      launchpad: 'noxa',
      deployerPct: 0.05,
      signal: 'evt-123',
      exitReason: 'take-profit-1',
      latencyMs: 850,
    })
  })

  it('an empty enrichment is a no-op merge', () => {
    const base = { a: 1 }
    expect(buildEnrichedTradeMeta(base, {})).toEqual({ a: 1 })
  })

  it('enrichment fields override a same-named base key (enrichment is authoritative)', () => {
    const base = { exitReason: 'stale' }
    const merged = buildEnrichedTradeMeta(base, { exitReason: 'trailing-stop' })
    expect(merged.exitReason).toBe('trailing-stop')
  })
})
