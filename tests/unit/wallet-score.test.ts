import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { WalletStatsRow } from '../../src/intelligence/wallet-store.js'
import {
  computeWalletScore,
  confidence,
  DEFAULT_SCALES,
  DEFAULT_WEIGHTS,
} from '../../src/intelligence/wallet-score.js'

const WALLET = '0x1111111111111111111111111111111111111a' as Address

function stats(overrides: Partial<WalletStatsRow> = {}): WalletStatsRow {
  return {
    wallet: WALLET,
    firstSeen: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    profitFactor: 0,
    maxDrawdownUsd: 0,
    rugExposure: 0,
    medianEntryMcapUsd: null,
    avgHoldMinutes: null,
    earlyEntryScore: null,
    lastUpdated: 0,
    ...overrides,
  }
}

describe('confidence — sample-size trust, not accuracy', () => {
  it('a 10-trade wallet and a 500-trade wallet are never scored with the same confidence', () => {
    const low = confidence(10, DEFAULT_SCALES)
    const high = confidence(500, DEFAULT_SCALES)
    expect(low).toBeLessThan(high)
    expect(high).toBe(1) // clamped at 1.0 past the target sample size
  })

  it('zero trades is zero confidence', () => {
    expect(confidence(0)).toBe(0)
  })

  it('is linear up to the configured target', () => {
    expect(confidence(25, DEFAULT_SCALES)).toBeCloseTo(25 / DEFAULT_SCALES.confidenceSampleTarget, 6)
  })
})

describe('computeWalletScore', () => {
  it('an empty-history wallet scores at (or near) the floor', () => {
    const result = computeWalletScore(stats())
    expect(result.score).toBeLessThan(20)
    expect(result.confidence).toBe(0)
  })

  it('a strong, consistent, well-sampled winner scores near the top of the range', () => {
    const strong = stats({
      totalTrades: 100,
      winningTrades: 80,
      losingTrades: 20,
      realizedPnlUsd: 10_000, // over the full-mark scale — clamped to 1.0 on that component
      avgWin: 150,
      avgLoss: 150, // symmetric wins/losses -> consistency component near 1.0
      winRate: 0.8,
      profitFactor: 4, // over the full-mark scale
      earlyEntryScore: 0.9,
      rugExposure: 0,
    })
    const result = computeWalletScore(strong)
    expect(result.score).toBeGreaterThan(85)
    expect(result.confidence).toBe(1)
  })

  it('component weights sum to 100, so a maxed-out wallet cannot exceed 100', () => {
    const weightSum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(weightSum).toBe(100)
  })

  it('rug exposure directly suppresses the rugAvoidance component', () => {
    const clean = computeWalletScore(stats({ totalTrades: 50, rugExposure: 0 }))
    const risky = computeWalletScore(stats({ totalTrades: 50, rugExposure: 1 }))
    expect(risky.components.rugAvoidance).toBeLessThan(clean.components.rugAvoidance)
    expect(risky.components.rugAvoidance).toBeCloseTo(0, 6)
  })

  it('a wallet with huge wins offsetting frequent tiny losses scores lower on consistency than one with symmetric wins/losses', () => {
    const streaky = computeWalletScore(
      stats({ totalTrades: 50, winningTrades: 5, losingTrades: 45, avgWin: 1000, avgLoss: 10 }),
    )
    const steady = computeWalletScore(
      stats({ totalTrades: 50, winningTrades: 25, losingTrades: 25, avgWin: 50, avgLoss: 50 }),
    )
    expect(steady.components.consistency).toBeGreaterThan(streaky.components.consistency)
  })

  it('custom weights are respected — zeroing a component removes its contribution entirely', () => {
    const s = stats({ totalTrades: 100, winningTrades: 90, losingTrades: 10, realizedPnlUsd: 5_000 })
    const withPnl = computeWalletScore(s, DEFAULT_WEIGHTS)
    const withoutPnl = computeWalletScore(s, { ...DEFAULT_WEIGHTS, realizedPnl: 0 })
    expect(withoutPnl.components.realizedPnl).toBe(0)
    expect(withoutPnl.score).toBeLessThan(withPnl.score)
  })

  it('an infinite profit factor (wins with zero recorded losses) is treated as a full score, not NaN/Infinity leaking through', () => {
    const result = computeWalletScore(
      stats({ totalTrades: 20, winningTrades: 20, losingTrades: 0, profitFactor: Infinity }),
    )
    expect(Number.isFinite(result.score)).toBe(true)
    expect(result.components.profitFactor).toBeCloseTo(DEFAULT_WEIGHTS.profitFactor, 6)
  })

  it('score is always clamped to [0, 100] even with adversarial inputs', () => {
    const result = computeWalletScore(
      stats({ totalTrades: 1_000_000, realizedPnlUsd: 1e12, profitFactor: 1e9, winRate: 5, rugExposure: -5 }),
    )
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })
})
