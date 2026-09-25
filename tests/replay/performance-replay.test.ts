/**
 * Level 9 acceptance: "1000件以上のReplay Datasetを通す。Performance report
 * 自動生成。" — synthesizes 1000+ closed round trips with a known win/loss
 * mix and asserts computePerformance() reproduces the expected aggregate
 * numbers from that real (if synthetic) trade history — not a mocked
 * report, an actually-computed one.
 */
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { computePerformance } from '../../src/analytics/performance.js'
import type { TradeRecord } from '../../src/framework/types.js'

const WETH = '0x2222222222222222222222222222222222222b' as Address

function addr(i: number): Address {
  return `0x${(i + 1).toString(16).padStart(40, '0')}` as Address
}

describe('Level 9 replay: performance report over 1000+ closed round trips', () => {
  it('auto-generates a performance report matching the known synthetic win/loss composition', () => {
    const N = 1000
    const trades: TradeRecord[] = []
    let ts = 0
    let wins = 0
    let losses = 0

    for (let i = 0; i < N; i++) {
      const token = addr(i)
      // 55% win rate, wins average +$15, losses average -$10 — a deliberately
      // positive-expectancy synthetic strategy so the report's sign is checkable.
      const isWin = i % 20 < 11 // 11/20 = 55%
      const buyUsd = 100
      const sellUsd = isWin ? 100 + 15 : 100 - 10
      if (isWin) wins++
      else losses++

      trades.push({
        agentId: 'sniper-1',
        mode: 'paper',
        ts: ts++,
        side: 'buy',
        token,
        tokenSymbol: 'MEME',
        quoteToken: WETH,
        quoteSymbol: 'WETH',
        amountIn: 0n,
        amountOut: 100n,
        txHash: null,
        reason: 'replay',
        slippageBps: 50 + (i % 100),
        gasEstimate: 100_000n,
        meta: { notionalUsd: buyUsd },
      })
      trades.push({
        agentId: 'sniper-1',
        mode: 'paper',
        ts: ts++,
        side: 'sell',
        token,
        tokenSymbol: 'MEME',
        quoteToken: WETH,
        quoteSymbol: 'WETH',
        amountIn: 100n,
        amountOut: 0n,
        txHash: null,
        reason: isWin ? 'take-profit-1' : 'stop-loss',
        slippageBps: 50 + (i % 100),
        gasEstimate: 110_000n,
        meta: { notionalUsd: sellUsd },
      })
    }

    expect(trades.length).toBe(N * 2)

    const report = computePerformance(
      trades,
      { totalSellAttempts: N, failedSells: 12 },
      { totalProbes: 300, failedProbes: 40 },
    )

    // every closed trade produced a win or a loss — nothing lost, nothing double-counted
    expect(report.winningTrades + report.losingTrades).toBe(N)
    expect(report.winningTrades).toBe(wins)
    expect(report.losingTrades).toBe(losses)
    expect(report.winRate).toBeCloseTo(wins / N, 6)
    expect(report.avgWinUsd).toBeCloseTo(15, 6)
    expect(report.avgLossUsd).toBeCloseTo(10, 6)
    expect(report.realizedPnlUsd).toBeCloseTo(wins * 15 - losses * 10, 4)
    expect(report.expectancyUsd).toBeCloseTo((wins * 15 - losses * 10) / N, 4)
    expect(report.profitFactor).toBeCloseTo((wins * 15) / (losses * 10), 4)
    expect(report.totalGasEstimate).toBe(BigInt(N) * (100_000n + 110_000n))
    expect(report.sellFailureRate).toBeCloseTo(12 / N, 6)
    expect(report.probeFailureRate).toBeCloseTo(40 / 300, 6)
    expect(Number.isFinite(report.sharpeLike)).toBe(true)
    expect(report.maxDrawdownUsd).toBeGreaterThanOrEqual(0)
  })
})
