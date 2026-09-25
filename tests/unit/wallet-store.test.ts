import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { WalletStore, type ClassifiedTradeInput } from '../../src/intelligence/wallet-store.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WALLET = '0x2222222222222222222222222222222222222b' as Address

function trade(overrides: Partial<ClassifiedTradeInput> = {}): ClassifiedTradeInput {
  return {
    token: TOKEN,
    wallet: WALLET,
    side: 'buy',
    amountTokenWei: '1000000000000000000',
    amountUsd: 100,
    mcapUsd: 1_000_000,
    blockNumber: 1n,
    transactionHash: '0xabc',
    logIndex: 0,
    ts: 1_000,
    secondsSinceLaunch: 30,
    ...overrides,
  }
}

describe('WalletStore — cursor-safe idempotent recording', () => {
  it('recordTrade returns true on first write, false on an identical replay (crash-safety simulation)', () => {
    const store = new WalletStore(':memory:')
    const first = store.recordTrade(trade())
    expect(first).toBe(true)

    // Simulates: DB transaction committed, process crashed BEFORE the cursor
    // update, restart re-reads the same block range and replays this log.
    const replay = store.recordTrade(trade())
    expect(replay).toBe(false)

    expect(store.get(WALLET)?.totalTrades).toBe(1) // not double-counted
  })

  it('a different logIndex on the same tx is a distinct trade, not a duplicate', () => {
    const store = new WalletStore(':memory:')
    store.recordTrade(trade({ logIndex: 0 }))
    store.recordTrade(trade({ logIndex: 1 }))
    expect(store.get(WALLET)?.totalTrades).toBe(2)
  })

  it('cursor only advances forward, never backward', () => {
    const store = new WalletStore(':memory:')
    expect(store.cursorFor(TOKEN)).toBeNull()
    store.advanceCursor(TOKEN, 100n)
    expect(store.cursorFor(TOKEN)).toBe(100n)
    store.advanceCursor(TOKEN, 50n) // an out-of-order/stale advance must not regress the cursor
    expect(store.cursorFor(TOKEN)).toBe(100n)
    store.advanceCursor(TOKEN, 150n)
    expect(store.cursorFor(TOKEN)).toBe(150n)
  })
})

describe('WalletStore — FIFO cost-basis accounting', () => {
  it('a clean buy then full sell realizes the exact PnL', () => {
    const store = new WalletStore(':memory:')
    store.recordTrade(trade({ side: 'buy', amountTokenWei: '100', amountUsd: 100, ts: 1_000, logIndex: 0 }))
    store.recordTrade(
      trade({ side: 'sell', amountTokenWei: '100', amountUsd: 150, ts: 1_000 + 5 * 60_000, logIndex: 1 }),
    )

    const stats = store.get(WALLET)!
    expect(stats.realizedPnlUsd).toBeCloseTo(50, 6)
    expect(stats.winningTrades).toBe(1)
    expect(stats.losingTrades).toBe(0)
    expect(stats.totalTrades).toBe(2)
    expect(stats.avgHoldMinutes).toBeCloseTo(5, 6)
  })

  it('a losing round trip is counted as a loss, not a win', () => {
    const store = new WalletStore(':memory:')
    store.recordTrade(trade({ side: 'buy', amountTokenWei: '100', amountUsd: 100, logIndex: 0 }))
    store.recordTrade(trade({ side: 'sell', amountTokenWei: '100', amountUsd: 60, logIndex: 1 }))
    const stats = store.get(WALLET)!
    expect(stats.realizedPnlUsd).toBeCloseTo(-40, 6)
    expect(stats.winningTrades).toBe(0)
    expect(stats.losingTrades).toBe(1)
  })

  it('FIFO matches a sell against the OLDEST lot first across two separate buys', () => {
    const store = new WalletStore(':memory:')
    // lot 1: 100 tokens for $100 (cost $1/token)
    store.recordTrade(trade({ side: 'buy', amountTokenWei: '100', amountUsd: 100, ts: 1_000, logIndex: 0 }))
    // lot 2: 100 tokens for $400 (cost $4/token) — much more expensive, must NOT be the one consumed first
    store.recordTrade(trade({ side: 'buy', amountTokenWei: '100', amountUsd: 400, ts: 2_000, logIndex: 1 }))
    // sell 100 tokens for $300 — should consume lot 1 entirely (cost $100), realizing $200 profit
    store.recordTrade(trade({ side: 'sell', amountTokenWei: '100', amountUsd: 300, ts: 3_000, logIndex: 2 }))

    const stats = store.get(WALLET)!
    expect(stats.realizedPnlUsd).toBeCloseTo(200, 6) // 300 - 100 (lot 1's cost), NOT 300 - 400
    const remaining = store.openPositions(WALLET, TOKEN)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.amountTokenWei).toBe(100n) // lot 2 untouched
    expect(remaining[0]!.costUsd).toBeCloseTo(400, 6)
  })

  it('a partial sell consumes a fraction of a lot and leaves the rest with proportional cost basis', () => {
    const store = new WalletStore(':memory:')
    store.recordTrade(trade({ side: 'buy', amountTokenWei: '100', amountUsd: 100, ts: 1_000, logIndex: 0 }))
    store.recordTrade(trade({ side: 'sell', amountTokenWei: '40', amountUsd: 60, ts: 2_000, logIndex: 1 }))

    const stats = store.get(WALLET)!
    // sold 40% of the lot, cost basis for that 40% = $40, proceeds $60 -> +$20
    expect(stats.realizedPnlUsd).toBeCloseTo(20, 6)
    const remaining = store.openPositions(WALLET, TOKEN)
    expect(remaining[0]!.amountTokenWei).toBe(60n)
    expect(remaining[0]!.costUsd).toBeCloseTo(60, 6) // 60% of the original $100 cost
  })

  it('max drawdown tracks the largest peak-to-trough dip in cumulative realized PnL', () => {
    const store = new WalletStore(':memory:')
    let li = 0
    const buySell = (buyUsd: number, sellUsd: number, amt = '100') => {
      store.recordTrade(trade({ side: 'buy', amountTokenWei: amt, amountUsd: buyUsd, logIndex: li++ }))
      store.recordTrade(trade({ side: 'sell', amountTokenWei: amt, amountUsd: sellUsd, logIndex: li++ }))
    }
    buySell(100, 200) // +100, cumulative 100 (new peak)
    buySell(100, 130) // +30, cumulative 130 (new peak)
    buySell(100, 50) // -50, cumulative 80 (drawdown from peak 130 = 50)
    buySell(100, 90) // -10, cumulative 70 (drawdown from peak 130 = 60, new max)

    const stats = store.get(WALLET)!
    expect(stats.realizedPnlUsd).toBeCloseTo(70, 6)
    expect(stats.maxDrawdownUsd).toBeCloseTo(60, 6)
  })

  it('median entry mcap is computed across all buys', () => {
    const store = new WalletStore(':memory:')
    store.recordTrade(trade({ side: 'buy', mcapUsd: 100_000, logIndex: 0 }))
    store.recordTrade(trade({ side: 'buy', mcapUsd: 300_000, logIndex: 1 }))
    store.recordTrade(trade({ side: 'buy', mcapUsd: 200_000, logIndex: 2 }))
    expect(store.get(WALLET)?.medianEntryMcapUsd).toBe(200_000)
  })

  it('early entry score averages across buys and is null with zero buys', () => {
    const store = new WalletStore(':memory:')
    expect(store.get(WALLET)).toBeNull()
    store.recordTrade(trade({ side: 'buy', secondsSinceLaunch: 0, logIndex: 0 })) // score 1.0 (instant)
    store.recordTrade(trade({ side: 'buy', secondsSinceLaunch: 300, logIndex: 1 })) // score 0.5 (half of the 600s window)
    expect(store.get(WALLET)!.earlyEntryScore).toBeCloseTo(0.75, 6)
  })
})
