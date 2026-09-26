import { describe, expect, it } from 'vitest'
import { buildEmergencyExitInput, NEUTRAL_ENTRY_SNAPSHOT } from '../../src/exits/emergency-monitor.js'
import { checkEmergencyExit } from '../../src/exits/emergency-exit.js'

describe('buildEmergencyExitInput — merges real scanner output with Agent-native signals, safely defaulting the rest', () => {
  it('with the neutral entry snapshot and no scanned signals, nothing ever trips (except the two Agent-native checks)', () => {
    const input = buildEmergencyExitInput(
      NEUTRAL_ENTRY_SNAPSHOT,
      {},
      { currentlySellable: true, quoteAnomalyDetected: false },
    )
    expect(checkEmergencyExit(input).shouldExit).toBe(false)
  })

  it('a scanned liquidity collapse below the neutral baseline still cannot trip liquidity_collapse (entryLiquidityScore must be > 0)', () => {
    const input = buildEmergencyExitInput(
      NEUTRAL_ENTRY_SNAPSHOT,
      { currentLiquidityScore: 0 },
      { currentlySellable: true, quoteAnomalyDetected: false },
    )
    expect(checkEmergencyExit(input).reasons).not.toContain('liquidity_collapse')
  })

  it('a real entry snapshot + a scanned current collapse trips liquidity_collapse', () => {
    const entry = { ...NEUTRAL_ENTRY_SNAPSHOT, liquidityScore: 100 }
    const input = buildEmergencyExitInput(
      entry,
      { currentLiquidityScore: 10 }, // well under half of 100
      { currentlySellable: true, quoteAnomalyDetected: false },
    )
    const verdict = checkEmergencyExit(input)
    expect(verdict.shouldExit).toBe(true)
    expect(verdict.reasons).toContain('liquidity_collapse')
  })

  it('Agent-native currentlySellable=false trips sellability_degradation on its own, with zero scanner involvement', () => {
    const input = buildEmergencyExitInput(
      NEUTRAL_ENTRY_SNAPSHOT,
      {},
      { currentlySellable: false, quoteAnomalyDetected: false },
    )
    expect(checkEmergencyExit(input).reasons).toContain('sellability_degradation')
  })

  it('Agent-native quoteAnomalyDetected=true trips rpc_quote_anomaly on its own', () => {
    const input = buildEmergencyExitInput(
      NEUTRAL_ENTRY_SNAPSHOT,
      {},
      { currentlySellable: true, quoteAnomalyDetected: true },
    )
    expect(checkEmergencyExit(input).reasons).toContain('rpc_quote_anomaly')
  })

  it('a missing scanned field falls back to the entry value (no perceived change), not to zero', () => {
    const entry = { ...NEUTRAL_ENTRY_SNAPSHOT, contractRiskScore: 50 }
    const input = buildEmergencyExitInput(entry, {}, { currentlySellable: true, quoteAnomalyDetected: false })
    expect(input.currentContractRiskScore).toBe(50)
    expect(checkEmergencyExit(input).reasons).not.toContain('critical_contract_change')
  })
})
