import type { Address } from 'viem'
import type { Market } from '../framework/market.js'
import { scanContractRisk } from '../security/contract-risk.js'
import { checkSellability } from '../security/sellability.js'
import { computeExecutableLiquidity } from '../security/liquidity.js'
import { computeWalletScore } from '../intelligence/wallet-score.js'
import type { WalletStore } from '../intelligence/wallet-store.js'
import type { EntityCluster } from '../intelligence/entity-cluster.js'
import { computeClusterSignal } from '../intelligence/cluster-signal.js'
import { buildFeatureVector, type FeatureVector } from './feature-vector.js'
import { evaluateEnsemble, type EnsembleOptions, type EnsembleResult } from './ensemble.js'
import type { HoodClient } from 'hoodchain'

export interface CandidateEvaluatorOptions {
  client: HoodClient
  market: Pick<Market, 'quoteBuy' | 'quoteSell'>
  walletStore: WalletStore
  entityCluster: EntityCluster
  probeAmountIn: bigint
}

export interface EvaluateCandidateInput {
  token: Address
  quoteToken: Address
  tokenAgeSeconds: number
  ensembleOptions: Omit<EnsembleOptions, never>
  windowMs?: number
  now?: number
}

/**
 * Orchestrates every signal Level 8's {@link FeatureVector} needs — real
 * RPC calls (Level 5's contract/sellability/liquidity scanners) plus real
 * durable-store reads (Level 3's wallet scores, Level 4's cluster signal) —
 * then runs the full 5-mode ensemble on the result. Kept separate from
 * feature-vector.ts (pure) and ensemble.ts (pure) on purpose: those two stay
 * trivially unit-testable with hand-built inputs; this is the IO-heavy glue
 * a real caller (e.g. a strategy wiring this in as shadow evaluation) uses.
 */
export async function evaluateCandidate(
  input: EvaluateCandidateInput,
  opts: CandidateEvaluatorOptions,
): Promise<{ featureVector: FeatureVector; ensemble: EnsembleResult }> {
  const now = input.now ?? Date.now()

  const [contractRisk, sellability] = await Promise.all([
    scanContractRisk(opts.client, input.token),
    checkSellability(opts.market, input.token, input.quoteToken, opts.probeAmountIn),
  ])

  const spotPriceUsd = sellability.buyAmountOut
    ? Number(sellability.buyAmountOut) / Number(opts.probeAmountIn)
    : 0
  const liquidity = await computeExecutableLiquidity(
    opts.market,
    input.token,
    input.quoteToken,
    spotPriceUsd,
    1,
  )

  const windowMs = input.windowMs ?? 5 * 60_000
  const buyerAddresses = opts.walletStore.recentBuyers(input.token, now - windowMs)
  const buyers = buyerAddresses.map((w) => {
    const stats = opts.walletStore.get(w)
    return { walletScore: stats ? computeWalletScore(stats).score : 0 }
  })
  const independentEntityCount = opts.entityCluster.independentEntityCount(buyerAddresses)
  const recentTradesRaw = opts.walletStore.recentTransfers(input.token, now - windowMs)
  const clusterSignal = computeClusterSignal(
    input.token,
    buyerAddresses.map((w, i) => ({
      wallet: w,
      ts: recentTradesRaw.find((t) => t.wallet.toLowerCase() === w.toLowerCase())?.ts ?? now,
      notionalUsd: recentTradesRaw
        .filter((t) => t.wallet.toLowerCase() === w.toLowerCase())
        .reduce((s, t) => s + t.amountUsd, 0),
      walletScore: buyers[i]!.walletScore,
    })),
    opts.entityCluster,
  )

  const deployerPct = null // resolved upstream by the caller today (e.g. LaunchSniper already computes it) — not re-fetched here to avoid a duplicate multicall

  const featureVector = buildFeatureVector({
    tokenAgeSeconds: input.tokenAgeSeconds,
    contractRisk,
    sellability,
    liquidity,
    deployerPct,
    buyers,
    independentEntityCount,
    clusterScore: clusterSignal.clusterScore,
    recentTrades: recentTradesRaw.map((t) => ({
      side: t.side,
      amountUsd: t.amountUsd,
      mcapUsd: t.mcapUsd,
      ts: t.ts,
    })),
    windowMs,
    now,
  })

  const ensemble = await evaluateEnsemble(featureVector, input.ensembleOptions)
  return { featureVector, ensemble }
}
