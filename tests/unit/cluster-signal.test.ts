import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { EntityCluster } from '../../src/intelligence/entity-cluster.js'
import { computeClusterSignal, type WalletBuy } from '../../src/intelligence/cluster-signal.js'

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

describe('computeClusterSignal', () => {
  it("reproduces the spec's own worked example: 4 independent smart wallets, 37s window, combined 356 -> cluster score ~94", () => {
    const cluster = new EntityCluster() // no funding edges recorded -> all 4 wallets independent by construction
    const wallets = [addr(1), addr(2), addr(3), addr(4)]
    const scores = [89, 89, 89, 89] // sums to 356, matching the spec example
    const t0 = 1_000_000
    const buys: WalletBuy[] = wallets.map((wallet, i) => ({
      wallet,
      ts: t0 + i * (37_000 / 3), // spread across 37 seconds total
      notionalUsd: 500,
      walletScore: scores[i]!,
    }))

    const signal = computeClusterSignal('0xtoken', buys, cluster)
    expect(signal.smartWalletCount).toBe(4)
    expect(signal.independentEntityCount).toBe(4)
    expect(signal.combinedWalletScore).toBe(356)
    expect(signal.timeWindowSeconds).toBeCloseTo(37, 0)
    expect(signal.clusterScore).toBeCloseTo(94, 0)
  })

  it('clustered (same-owner) wallets collapse independent_entity_count and lower the score vs. the same wallets being independent', () => {
    const wallets = [addr(10), addr(11), addr(12), addr(13)]
    const buys: WalletBuy[] = wallets.map((wallet, i) => ({
      wallet,
      ts: 1_000_000 + i * 1000,
      notionalUsd: 500,
      walletScore: 89,
    }))

    const independentCluster = new EntityCluster()
    const independentSignal = computeClusterSignal('0xtoken', buys, independentCluster)

    const sameOwnerCluster = new EntityCluster()
    const funder = addr(999)
    for (const w of wallets) sameOwnerCluster.recordFunding(funder, w)
    const sameOwnerSignal = computeClusterSignal('0xtoken', buys, sameOwnerCluster)

    expect(sameOwnerSignal.independentEntityCount).toBe(1)
    expect(sameOwnerSignal.fundingOverlap).toBeCloseTo(0.75, 6) // 1 - 1/4
    expect(sameOwnerSignal.clusterScore).toBeLessThan(independentSignal.clusterScore)
  })

  it('wallets below the smart-wallet threshold do not count toward smartWalletCount or the combined score', () => {
    const cluster = new EntityCluster()
    const buys: WalletBuy[] = [
      { wallet: addr(20), ts: 1000, notionalUsd: 100, walletScore: 90 },
      { wallet: addr(21), ts: 1000, notionalUsd: 100, walletScore: 30 }, // below default threshold (60)
    ]
    const signal = computeClusterSignal('0xtoken', buys, cluster)
    expect(signal.smartWalletCount).toBe(1)
    expect(signal.combinedWalletScore).toBe(90)
    expect(signal.totalNotionalUsd).toBe(200) // notional still counts every buy, smart or not
  })

  it('a wider time window (weaker signal) scores lower than a tight one, all else equal', () => {
    const cluster = new EntityCluster()
    const wallets = [addr(30), addr(31)]
    const tight: WalletBuy[] = wallets.map((wallet, i) => ({
      wallet,
      ts: i * 1000,
      notionalUsd: 100,
      walletScore: 90,
    }))
    const wide: WalletBuy[] = wallets.map((wallet, i) => ({
      wallet,
      ts: i * 20 * 60 * 1000, // 20 minutes apart
      notionalUsd: 100,
      walletScore: 90,
    }))
    expect(computeClusterSignal('t', wide, cluster).clusterScore).toBeLessThan(
      computeClusterSignal('t', tight, cluster).clusterScore,
    )
  })

  it('an empty buy list produces a zeroed, non-crashing signal', () => {
    const cluster = new EntityCluster()
    const signal = computeClusterSignal('0xtoken', [], cluster)
    expect(signal.smartWalletCount).toBe(0)
    expect(signal.clusterScore).toBe(0)
    expect(signal.medianWalletScore).toBe(0)
    expect(signal.fundingOverlap).toBe(0)
  })
})
