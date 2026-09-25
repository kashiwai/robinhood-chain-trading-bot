import { describe, expect, it } from 'vitest'
import { suggestParameterChange } from '../../src/analytics/optimization-suggestions.js'
import type { PerformanceReport } from '../../src/analytics/performance.js'

function report(overrides: Partial<PerformanceReport> = {}): PerformanceReport {
  return {
    totalTrades: 100,
    winningTrades: 50,
    losingTrades: 50,
    winRate: 0.5,
    avgWinUsd: 20,
    avgLossUsd: 15,
    expectancyUsd: 2.5,
    profitFactor: 1.33,
    realizedPnlUsd: 250,
    maxDrawdownUsd: 100,
    sharpeLike: 0.5,
    totalGasEstimate: 0n,
    avgSlippageBps: 80,
    sellFailureRate: 0.02,
    probeFailureRate: 0.05,
    ...overrides,
  }
}

describe('suggestParameterChange', () => {
  it('never mutates or applies anything — it only returns a data object (structural check: no side-effect-bearing params)', () => {
    const s = suggestParameterChange('maxDeployerPct', 0.15, 0.1, report(), report({ winRate: 0.6 }))
    expect(s.parameter).toBe('maxDeployerPct')
    expect(s.currentValue).toBe(0.15)
    expect(s.suggestedValue).toBe(0.1)
  })

  it('describes a real positive win-rate delta in expectedImpact', () => {
    const s = suggestParameterChange('x', 1, 2, report({ winRate: 0.5 }), report({ winRate: 0.6 }))
    expect(s.expectedImpact).toMatch(/win rate \+10\.0pt/)
  })

  it('describes a real negative expectancy delta', () => {
    const s = suggestParameterChange('x', 1, 2, report({ expectancyUsd: 5 }), report({ expectancyUsd: 2 }))
    expect(s.expectedImpact).toMatch(/expectancy -\$3\.00\/trade/)
  })

  it('a negligible difference reports "no material difference detected", not a fabricated delta', () => {
    const s = suggestParameterChange('x', 1, 2, report(), report({ winRate: 0.501 }))
    expect(s.expectedImpact).toBe('no material difference detected')
  })

  it('confidence scales with the SMALLER of the two sample sizes — a thin comparison is flagged low-confidence regardless of the apparent delta', () => {
    const thin = suggestParameterChange(
      'x',
      1,
      2,
      report({ totalTrades: 10 }),
      report({ totalTrades: 500, winRate: 0.9 }),
    )
    const solid = suggestParameterChange(
      'x',
      1,
      2,
      report({ totalTrades: 500 }),
      report({ totalTrades: 500, winRate: 0.9 }),
    )
    expect(thin.confidence).toBeLessThan(solid.confidence)
  })

  it('confidence is clamped to 1.0 at/above the target sample size, not unbounded', () => {
    const s = suggestParameterChange(
      'x',
      1,
      2,
      report({ totalTrades: 10_000 }),
      report({ totalTrades: 10_000 }),
    )
    expect(s.confidence).toBe(1)
  })

  it('beforePerformance carries through the real before-report numbers, not the after ones', () => {
    const s = suggestParameterChange(
      'x',
      1,
      2,
      report({ winRate: 0.4, totalTrades: 77 }),
      report({ winRate: 0.9 }),
    )
    expect(s.beforePerformance.winRate).toBe(0.4)
    expect(s.beforePerformance.totalTrades).toBe(77)
  })
})
