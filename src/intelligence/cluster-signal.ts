import type { Address } from 'viem'
import type { EntityCluster } from './entity-cluster.js'

export interface WalletBuy {
  wallet: Address
  ts: number
  notionalUsd: number
  walletScore: number
}

export interface ClusterSignal {
  token: string
  smartWalletCount: number
  independentEntityCount: number
  combinedWalletScore: number
  timeWindowSeconds: number
  totalNotionalUsd: number
  medianWalletScore: number
  fundingOverlap: number
  clusterScore: number
}

export interface ClusterSignalScales {
  /** Wallet score (0-100) a buy must meet to count as a "smart wallet". @defaultValue 60 */
  smartWalletScoreThreshold: number
  /** Combined score that earns full marks on that component. @defaultValue 400 */
  combinedScoreFullMark: number
  /** Time window (seconds) at/above which the tightness component drops to 0. @defaultValue 600 */
  timeWindowFullSpreadSeconds: number
}

export const DEFAULT_CLUSTER_SCALES: ClusterSignalScales = {
  smartWalletScoreThreshold: 60,
  combinedScoreFullMark: 400,
  timeWindowFullSpreadSeconds: 600,
}

/**
 * "3 wallets bought" is not 3 independent bullish signals if they're the
 * same money — this collapses a set of buys on one token into the signal the
 * spec asks for. `cluster` (see entity-cluster.ts) has already resolved
 * which wallets share a funding source; this only aggregates.
 *
 * cluster_score is, like wallet-score.ts, an explicitly documented initial
 * heuristic (weights sum to 100: 40 independence + 40 combined-strength + 20
 * time-tightness) — calibrated so the spec's own worked example (4
 * independent smart wallets, 37s window, combined score 356 -> cluster score
 * 94) reproduces almost exactly under the default scales; see
 * cluster-signal.test.ts.
 */
export function computeClusterSignal(
  token: string,
  buys: readonly WalletBuy[],
  cluster: EntityCluster,
  scales: ClusterSignalScales = DEFAULT_CLUSTER_SCALES,
): ClusterSignal {
  const smart = buys.filter((b) => b.walletScore >= scales.smartWalletScoreThreshold)
  const wallets = smart.map((b) => b.wallet)
  const independentEntityCount = cluster.independentEntityCount(wallets)
  const combinedWalletScore = smart.reduce((s, b) => s + b.walletScore, 0)
  const totalNotionalUsd = buys.reduce((s, b) => s + b.notionalUsd, 0)
  const timestamps = buys.map((b) => b.ts)
  const timeWindowSeconds =
    timestamps.length > 0 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 1000 : 0
  const medianWalletScore = median(smart.map((b) => b.walletScore))
  const fundingOverlap = smart.length > 0 ? 1 - independentEntityCount / smart.length : 0

  // No smart-wallet buys at all -> no cluster signal, full stop. Without this
  // guard, a zero-length timestamp spread reads as a (vacuously) "perfectly
  // tight" window and leaks points into clusterScore for a dataset with
  // nothing in it.
  let clusterScore = 0
  if (smart.length > 0) {
    const independenceRatio = independentEntityCount / smart.length
    const combinedStrength = Math.min(1, combinedWalletScore / scales.combinedScoreFullMark)
    const timeTightness = Math.max(0, 1 - timeWindowSeconds / scales.timeWindowFullSpreadSeconds)
    clusterScore = clamp(independenceRatio * 40 + combinedStrength * 40 + timeTightness * 20, 0, 100)
  }

  return {
    token,
    smartWalletCount: smart.length,
    independentEntityCount,
    combinedWalletScore,
    timeWindowSeconds,
    totalNotionalUsd,
    medianWalletScore,
    fundingOverlap,
    clusterScore,
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
