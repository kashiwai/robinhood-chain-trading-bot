import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { computePerformance } from '../../src/analytics/performance.js'
import type { TradeRecord } from '../../src/framework/types.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address

function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    agentId: 'sniper-1',
    mode: 'paper',
    ts: 0,
    side: 'buy',
    token: TOKEN,
    tokenSymbol: 'MEME',
    quoteToken: WETH,
    quoteSymbol: 'WETH',
    amountIn: 0n,
    amountOut: 0n,
    txHash: null,
    reason: 'test',
    slippageBps: 100,
    gasEstimate: 100_000n,
    meta: {},
    ...overrides,
  }
}

describe('computePerformance', () => {
  it('empty trade history is all zeros, not NaN/Infinity/crash', () => {
    const r = computePerformance([])
    expect(r.totalTrades).toBe(0)
    expect(r.winRate).toBe(0)
    expect(r.profitFactor).toBe(0)
    expect(r.sharpeLike).toBe(0)
  })

  it('a single winning round trip', () => {
    const trades: TradeRecord[] = [
      trade({ side: 'buy', ts: 1000, amountOut: 100n, meta: { notionalUsd: 20 } }),
      trade({ side: 'sell', ts: 2000, amountIn: 100n, meta: { notionalUsd: 30 } }),
    ]
    const r = computePerformance(trades)
    expect(r.winningTrades).toBe(1)
    expect(r.losingTrades).toBe(0)
    expect(r.winRate).toBe(1)
    expect(r.realizedPnlUsd).toBeCloseTo(10, 6)
    expect(r.avgWinUsd).toBeCloseTo(10, 6)
  })

  it('a single losing round trip', () => {
    const trades: TradeRecord[] = [
      trade({ side: 'buy', ts: 1000, amountOut: 100n, meta: { notionalUsd: 20 } }),
      trade({ side: 'sell', ts: 2000, amountIn: 100n, meta: { notionalUsd: 12 } }),
    ]
    const r = computePerformance(trades)
    expect(r.losingTrades).toBe(1)
    expect(r.realizedPnlUsd).toBeCloseTo(-8, 6)
    expect(r.avgLossUsd).toBeCloseTo(8, 6)
  })

  it('FIFO matches sells against the OLDEST buy lot first, across two buys of different cost', () => {
    const trades: TradeRecord[] = [
      trade({ side: 'buy', ts: 1000, amountOut: 100n, meta: { notionalUsd: 10 } }), // $0.10/token
      trade({ side: 'buy', ts: 2000, amountOut: 100n, meta: { notionalUsd: 40 } }), // $0.40/token — must not be consumed first
      trade({ side: 'sell', ts: 3000, amountIn: 100n, meta: { notionalUsd: 30 } }), // sells exactly lot 1's size
    ]
    const r = computePerformance(trades)
    expect(r.realizedPnlUsd).toBeCloseTo(20, 6) // 30 - 10 (lot 1's cost), NOT 30 - 40
  })

  it('an open (unclosed) buy with no matching sell contributes zero realized PnL and is not counted as a win or loss', () => {
    const trades: TradeRecord[] = [
      trade({ side: 'buy', ts: 1000, amountOut: 100n, meta: { notionalUsd: 20 } }),
    ]
    const r = computePerformance(trades)
    expect(r.totalTrades).toBe(1)
    expect(r.winningTrades).toBe(0)
    expect(r.losingTrades).toBe(0)
    expect(r.realizedPnlUsd).toBe(0)
  })

  it('profitFactor is Infinity for an all-winning history with zero losses, not NaN', () => {
    const trades: TradeRecord[] = [
      trade({ side: 'buy', ts: 1000, amountOut: 100n, meta: { notionalUsd: 10 } }),
      trade({ side: 'sell', ts: 2000, amountIn: 100n, meta: { notionalUsd: 20 } }),
    ]
    const r = computePerformance(trades)
    expect(r.profitFactor).toBe(Infinity)
  })

  it('maxDrawdownUsd tracks the largest peak-to-trough dip across a sequence of round trips', () => {
    let ts = 0
    const roundTrip = (buyUsd: number, sellUsd: number): TradeRecord[] => {
      ts += 1000
      const buyTs = ts
      ts += 1000
      return [
        trade({ side: 'buy', ts: buyTs, amountOut: 100n, meta: { notionalUsd: buyUsd } }),
        trade({ side: 'sell', ts, amountIn: 100n, meta: { notionalUsd: sellUsd } }),
      ]
    }
    const trades = [
      ...roundTrip(100, 200),
      ...roundTrip(100, 130),
      ...roundTrip(100, 50),
      ...roundTrip(100, 90),
    ]
    const r = computePerformance(trades)
    // cumulative: +100 (peak 100) -> +130 (peak 130) -> +80 (dd 50) -> +70 (dd 60, new max)
    expect(r.maxDrawdownUsd).toBeCloseTo(60, 6)
  })

  it('gas and slippage are aggregated from every trade, buy or sell', () => {
    const trades: TradeRecord[] = [
      trade({
        side: 'buy',
        gasEstimate: 100_000n,
        slippageBps: 50,
        meta: { notionalUsd: 10 },
        amountOut: 100n,
      }),
      trade({
        side: 'sell',
        gasEstimate: 120_000n,
        slippageBps: 150,
        meta: { notionalUsd: 15 },
        amountIn: 100n,
      }),
    ]
    const r = computePerformance(trades)
    expect(r.totalGasEstimate).toBe(220_000n)
    expect(r.avgSlippageBps).toBeCloseTo(100, 6)
  })

  it('sell/probe failure rates come from the caller-supplied counters, not derived from trades', () => {
    const r = computePerformance(
      [],
      { totalSellAttempts: 20, failedSells: 3 },
      { totalProbes: 10, failedProbes: 4 },
    )
    expect(r.sellFailureRate).toBeCloseTo(0.15, 6)
    expect(r.probeFailureRate).toBeCloseTo(0.4, 6)
  })

  it('a consistent (low-variance) PnL sequence scores a higher sharpeLike than an equally-profitable but streaky one', () => {
    const steadyTrades: TradeRecord[] = [10, 12, 9, 11].flatMap((pnl, i) => [
      trade({ side: 'buy', ts: i * 1000, amountOut: 100n, meta: { notionalUsd: 100 } }),
      trade({ side: 'sell', ts: i * 1000 + 500, amountIn: 100n, meta: { notionalUsd: 100 + pnl } }),
    ])
    const streakyTrades: TradeRecord[] = [40, -20, 40, -18].flatMap((pnl, i) => [
      trade({ side: 'buy', ts: i * 1000, amountOut: 100n, meta: { notionalUsd: 100 } }),
      trade({ side: 'sell', ts: i * 1000 + 500, amountIn: 100n, meta: { notionalUsd: 100 + pnl } }),
    ])
    const steady = computePerformance(steadyTrades)
    const streaky = computePerformance(streakyTrades)
    expect(steady.sharpeLike).toBeGreaterThan(streaky.sharpeLike)
  })
})
