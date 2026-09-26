import type { Address } from 'viem'
import type { EmergencyExitInput } from './emergency-exit.js'

/** Captured once, at the moment a position opens — the baseline every later tick compares against. */
export interface EmergencyEntrySnapshot {
  liquidityScore: number
  contractRiskScore: number
  roundTripRetention: number | null
  /** Known only when the opening strategy supplies it (e.g. LaunchSniper knows the launch's creator address) — null elsewhere, which safely disables the deployer-dump check for that position. */
  deployerAddress: Address | null
}

/** A snapshot that never trips any comparison-based emergency condition — the safe default when no real scanner is wired. */
export const NEUTRAL_ENTRY_SNAPSHOT: EmergencyEntrySnapshot = {
  liquidityScore: 0, // checkEmergencyExit requires entryLiquidityScore > 0 before comparing
  contractRiskScore: 0,
  roundTripRetention: null, // null on either side skips the retention-drop check
  deployerAddress: null,
}

/**
 * The real, IO-heavy half of emergency monitoring — Level 5 security scans
 * (`scanContractRisk`, `computeExecutableLiquidity`, `checkSellability`) and
 * Level 3/4 wallet intelligence (`WalletStore`, `EntityCluster`), wired by
 * main.ts. Deliberately optional on {@link AgentOptions} — every field this
 * doesn't supply falls back to a value that never trips a check (see
 * `mergeEmergencySignals`), so a strategy/test that doesn't wire this keeps
 * the SAME behavior it always had, just without the extra emergency layer.
 */
export interface EmergencyMonitorHooks {
  /**
   * Called once, synchronously within the buy's execution, before the
   * position is recorded. `intentMeta` is the opening intent's own
   * strategy-supplied meta (e.g. LaunchSniper sets `deployerAddress`) — read
   * from it, never written to; the returned snapshot is what actually gets
   * stored.
   */
  captureEntry(
    token: Address,
    quoteToken: Address,
    now: number,
    intentMeta: Record<string, unknown>,
  ): Promise<EmergencyEntrySnapshot>
  /** Called every tick per open position needing a rescan (see `shouldRescan`/`rescanIntervalMs`). */
  currentSignals(
    token: Address,
    quoteToken: Address,
    entry: EmergencyEntrySnapshot,
    now: number,
  ): Promise<Partial<Omit<EmergencyExitInput, 'currentlySellable' | 'quoteAnomalyDetected'>>>
}

/**
 * Merges the caller-scanned signals (from {@link EmergencyMonitorHooks}, or
 * `{}` if none configured) with the two signals {@link Agent} computes
 * itself for free every tick (`currentlySellable` from the sell-quote it
 * already fetches in `markPositions`; `quoteAnomalyDetected` from the
 * mark-to-mark price delta) into a complete {@link EmergencyExitInput}.
 */
export function buildEmergencyExitInput(
  entry: EmergencyEntrySnapshot,
  scanned: Partial<Omit<EmergencyExitInput, 'currentlySellable' | 'quoteAnomalyDetected'>>,
  agentComputed: { currentlySellable: boolean; quoteAnomalyDetected: boolean },
): EmergencyExitInput {
  return {
    currentLiquidityScore: scanned.currentLiquidityScore ?? entry.liquidityScore,
    entryLiquidityScore: entry.liquidityScore,
    currentContractRiskScore: scanned.currentContractRiskScore ?? entry.contractRiskScore,
    entryContractRiskScore: entry.contractRiskScore,
    currentlySellable: agentComputed.currentlySellable,
    currentRoundTripRetention: scanned.currentRoundTripRetention ?? entry.roundTripRetention,
    entryRoundTripRetention: entry.roundTripRetention,
    deployerBalanceDropped: scanned.deployerBalanceDropped ?? false,
    smartMoneyNowSelling: scanned.smartMoneyNowSelling ?? false,
    buyPressureUsd: scanned.buyPressureUsd ?? 0,
    sellPressureUsd: scanned.sellPressureUsd ?? 0,
    quoteAnomalyDetected: agentComputed.quoteAnomalyDetected,
  }
}
