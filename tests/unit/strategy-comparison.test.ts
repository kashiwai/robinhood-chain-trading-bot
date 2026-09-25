import { describe, expect, it } from 'vitest'
import { compareStrategies, type StrategySample } from '../../src/analytics/strategy-comparison.js'

function sample(overrides: Partial<StrategySample> = {}): StrategySample {
  return { mode: 'RULE', decision: 'WATCH', confidence: 0.5, realizedPnlUsd: null, ...overrides }
}

describe('compareStrategies', () => {
  it('groups samples by mode independently', () => {
    const samples: StrategySample[] = [
      sample({ mode: 'RULE', decision: 'BUY' }),
      sample({ mode: 'JEV', decision: 'REJECT' }),
    ]
    const result = compareStrategies(samples)
    expect(result).toHaveLength(2)
    expect(result.find((r) => r.mode === 'RULE')?.buyCount).toBe(1)
    expect(result.find((r) => r.mode === 'JEV')?.rejectCount).toBe(1)
  })

  it('buyRate is the fraction of BUY decisions within that mode', () => {
    const samples: StrategySample[] = [
      sample({ mode: 'RULE', decision: 'BUY' }),
      sample({ mode: 'RULE', decision: 'WATCH' }),
      sample({ mode: 'RULE', decision: 'REJECT' }),
      sample({ mode: 'RULE', decision: 'REJECT' }),
    ]
    const [summary] = compareStrategies(samples)
    expect(summary!.buyRate).toBeCloseTo(0.25, 6)
  })

  it('avgRealizedPnlWhenBuy is null when no BUY sample has a known outcome', () => {
    const samples: StrategySample[] = [sample({ decision: 'BUY', realizedPnlUsd: null })]
    const [summary] = compareStrategies(samples)
    expect(summary!.avgRealizedPnlWhenBuy).toBeNull()
    expect(summary!.samplesWithKnownBuyOutcome).toBe(0)
  })

  it('avgRealizedPnlWhenBuy averages ONLY the known-outcome BUY samples, ignoring unknowns and non-BUY decisions', () => {
    const samples: StrategySample[] = [
      sample({ decision: 'BUY', realizedPnlUsd: 10 }),
      sample({ decision: 'BUY', realizedPnlUsd: 30 }),
      sample({ decision: 'BUY', realizedPnlUsd: null }), // unknown outcome — excluded from the average
      sample({ decision: 'WATCH', realizedPnlUsd: 999 }), // not a BUY — excluded regardless of having an outcome
    ]
    const [summary] = compareStrategies(samples)
    expect(summary!.avgRealizedPnlWhenBuy).toBeCloseTo(20, 6) // (10+30)/2
    expect(summary!.samplesWithKnownBuyOutcome).toBe(2)
  })

  it('meanConfidence is computed across every sample regardless of decision', () => {
    const samples: StrategySample[] = [sample({ confidence: 0.2 }), sample({ confidence: 0.8 })]
    const [summary] = compareStrategies(samples)
    expect(summary!.meanConfidence).toBeCloseTo(0.5, 6)
  })

  it('an empty sample set produces an empty summary list, not a crash', () => {
    expect(compareStrategies([])).toEqual([])
  })

  it('this IS the "same replay dataset, compare strategies" case: 5 modes, same candidates, one summary each', () => {
    const modes = ['RULE', 'JEV', 'RULE_JEV', 'JEV_SMART_WALLET', 'JEV_SMART_WALLET_CLUSTER'] as const
    const samples: StrategySample[] = modes.flatMap((mode) => [
      sample({ mode, decision: 'BUY', realizedPnlUsd: 15 }),
      sample({ mode, decision: 'REJECT' }),
    ])
    const result = compareStrategies(samples)
    expect(result.map((r) => r.mode).sort()).toEqual([...modes].sort())
    for (const summary of result) {
      expect(summary.totalSamples).toBe(2)
      expect(summary.avgRealizedPnlWhenBuy).toBeCloseTo(15, 6)
    }
  })
})
