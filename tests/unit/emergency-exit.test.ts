import { describe, expect, it } from 'vitest'
import { checkEmergencyExit, type EmergencyExitInput } from '../../src/exits/emergency-exit.js'

function clean(overrides: Partial<EmergencyExitInput> = {}): EmergencyExitInput {
  return {
    currentLiquidityScore: 80,
    entryLiquidityScore: 80,
    currentContractRiskScore: 5,
    entryContractRiskScore: 5,
    currentlySellable: true,
    currentRoundTripRetention: 0.95,
    entryRoundTripRetention: 0.95,
    deployerBalanceDropped: false,
    smartMoneyNowSelling: false,
    buyPressureUsd: 100,
    sellPressureUsd: 50,
    quoteAnomalyDetected: false,
    ...overrides,
  }
}

describe('checkEmergencyExit — the seven named conditions', () => {
  it('a fully clean position has no emergency', () => {
    expect(checkEmergencyExit(clean())).toEqual({ shouldExit: false, reasons: [] })
  })

  it('liquidity_collapse: current score fell below half the entry score', () => {
    const v = checkEmergencyExit(clean({ entryLiquidityScore: 80, currentLiquidityScore: 30 }))
    expect(v.shouldExit).toBe(true)
    expect(v.reasons).toContain('liquidity_collapse')
  })

  it('liquidity dropping but staying above half the entry score is NOT a collapse', () => {
    const v = checkEmergencyExit(clean({ entryLiquidityScore: 80, currentLiquidityScore: 50 }))
    expect(v.reasons).not.toContain('liquidity_collapse')
  })

  it('deployer_dump: a caller-detected balance drop', () => {
    const v = checkEmergencyExit(clean({ deployerBalanceDropped: true }))
    expect(v.reasons).toContain('deployer_dump')
  })

  it('critical_contract_change: a large jump from entry', () => {
    const v = checkEmergencyExit(clean({ entryContractRiskScore: 5, currentContractRiskScore: 40 }))
    expect(v.reasons).toContain('critical_contract_change')
  })

  it('critical_contract_change: an absolute floor, even without a big jump from a high entry', () => {
    const v = checkEmergencyExit(clean({ entryContractRiskScore: 70, currentContractRiskScore: 85 }))
    expect(v.reasons).toContain('critical_contract_change')
  })

  it('sellability_degradation: currently cannot sell at all', () => {
    const v = checkEmergencyExit(clean({ currentlySellable: false }))
    expect(v.reasons).toContain('sellability_degradation')
  })

  it('sellability_degradation: retention dropped 30+ points from entry', () => {
    const v = checkEmergencyExit(clean({ entryRoundTripRetention: 0.95, currentRoundTripRetention: 0.6 }))
    expect(v.reasons).toContain('sellability_degradation')
  })

  it('a small retention dip (under 30 points) is not degradation', () => {
    const v = checkEmergencyExit(clean({ entryRoundTripRetention: 0.95, currentRoundTripRetention: 0.8 }))
    expect(v.reasons).not.toContain('sellability_degradation')
  })

  it('cluster_smart_money_exit: caller-detected smart wallets flipping to sellers', () => {
    const v = checkEmergencyExit(clean({ smartMoneyNowSelling: true }))
    expect(v.reasons).toContain('cluster_smart_money_exit')
  })

  it('extreme_sell_pressure: sell pressure at least 3x buy pressure AND above the minimum floor', () => {
    const v = checkEmergencyExit(clean({ buyPressureUsd: 10, sellPressureUsd: 100 }))
    expect(v.reasons).toContain('extreme_sell_pressure')
  })

  it('a 3x ratio on trivially small amounts does not trip extreme_sell_pressure', () => {
    const v = checkEmergencyExit(clean({ buyPressureUsd: 1, sellPressureUsd: 5 })) // 5x ratio but under the $20 floor
    expect(v.reasons).not.toContain('extreme_sell_pressure')
  })

  it('rpc_quote_anomaly: caller-detected', () => {
    const v = checkEmergencyExit(clean({ quoteAnomalyDetected: true }))
    expect(v.reasons).toContain('rpc_quote_anomaly')
  })

  it('multiple simultaneous conditions are ALL reported, not just the first', () => {
    const v = checkEmergencyExit(
      clean({ deployerBalanceDropped: true, quoteAnomalyDetected: true, smartMoneyNowSelling: true }),
    )
    expect(v.reasons).toHaveLength(3)
  })
})
