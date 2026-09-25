import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { parseEther } from 'viem'
import type { OrderRow } from '../../src/execution/order-store.js'
import { ProbeEngine } from '../../src/execution/probe.js'
import { ProbeStore } from '../../src/execution/probe-store.js'
import { FakeMarket } from './helpers/fake-market.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    idempotencyKey: 'k',
    agentId: 'a',
    token: TOKEN,
    side: 'buy',
    quoteToken: WETH,
    amountIn: 0n,
    state: 'RECONCILED',
    nonce: 0,
    txHash: '0xabc',
    quotedAmountOut: 1000n,
    actualAmountOut: 1000n,
    actualPrice: null,
    actualSlippageBps: null,
    error: null,
    attempts: 1,
    createdAt: 0,
    submittedAt: 0,
    minedAt: 0,
    confirmedAt: 0,
    reconciledAt: 0,
    ...overrides,
  }
}

function input(overrides: Partial<{ quoteTokenUsdPrice: number }> = {}) {
  return {
    token: TOKEN,
    quoteToken: WETH,
    quoteTokenUsdPrice: 2000, // $2000/WETH
    quoteDecimals: 18,
    slippageBps: 100,
    ...overrides,
  }
}

describe('ProbeEngine', () => {
  it('a previously blacklisted token short-circuits without touching the executor', async () => {
    const probeStore = new ProbeStore(':memory:')
    probeStore.record({
      token: TOKEN,
      passed: false,
      reason: 'prior failure',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts: 0,
    })
    const execute = vi.fn()
    const engine = new ProbeEngine({
      executor: { execute },
      market: new FakeMarket() as never,
      probeStore,
      agentId: 'a',
    })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/blacklisted/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('a previously-passed token short-circuits as passed, without re-spending', async () => {
    const probeStore = new ProbeStore(':memory:')
    probeStore.record({
      token: TOKEN,
      passed: true,
      reason: 'ok',
      measuredBuyTaxBps: 100,
      measuredSellTaxBps: 50,
      ts: 0,
    })
    const execute = vi.fn()
    const engine = new ProbeEngine({
      executor: { execute },
      market: new FakeMarket() as never,
      probeStore,
      agentId: 'a',
    })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('no buy route at probe size blacklists the token', async () => {
    const probeStore = new ProbeStore(':memory:')
    const execute = vi.fn()
    const market = new FakeMarket() // no buyRoutes configured
    const engine = new ProbeEngine({ executor: { execute }, market, probeStore, agentId: 'a' })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(false)
    expect(probeStore.isBlacklisted(TOKEN)).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('a failed probe buy blacklists the token and never attempts the sell leg', async () => {
    const probeStore = new ProbeStore(':memory:')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    const execute = vi
      .fn()
      .mockResolvedValueOnce(order({ state: 'FAILED', actualAmountOut: null, error: 'reverted' }))
    const engine = new ProbeEngine({ executor: { execute }, market, probeStore, agentId: 'a' })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/probe buy failed/)
    expect(execute).toHaveBeenCalledTimes(1) // buy attempted, sell never reached
    expect(probeStore.isBlacklisted(TOKEN)).toBe(true)
  })

  it('a clean buy but no sell route (honeypot revealed by the probe) blacklists the token', async () => {
    const probeStore = new ProbeStore(':memory:')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    // no sellRoutes entry -> quoteSell resolves null
    const execute = vi
      .fn()
      .mockResolvedValueOnce(order({ state: 'RECONCILED', actualAmountOut: parseEther('1000') }))
    const engine = new ProbeEngine({ executor: { execute }, market, probeStore, agentId: 'a' })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/honeypot/)
    expect(execute).toHaveBeenCalledTimes(1) // the sell never reached execute() — caught at the quote stage
    expect(probeStore.isBlacklisted(TOKEN)).toBe(true)
  })

  it('a failed probe SELL (quote succeeded, actual execution failed) blacklists the token', async () => {
    const probeStore = new ProbeStore(':memory:')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.0009'))
    const execute = vi
      .fn()
      .mockResolvedValueOnce(order({ state: 'RECONCILED', actualAmountOut: parseEther('1000') })) // buy
      .mockResolvedValueOnce(order({ state: 'FAILED', actualAmountOut: null, error: 'sell reverted' })) // sell
    const engine = new ProbeEngine({ executor: { execute }, market, probeStore, agentId: 'a' })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/probe sell failed/)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(probeStore.isBlacklisted(TOKEN)).toBe(true)
  })

  it('a fully successful probe passes and measures real buy/sell tax from actual vs quoted amounts', async () => {
    const probeStore = new ProbeStore(':memory:')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000')) // quoted
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.001')) // quoted
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        order({
          state: 'RECONCILED',
          actualAmountOut: parseEther('950'),
          quotedAmountOut: parseEther('1000'),
        }),
      ) // 5% buy tax
      .mockResolvedValueOnce(
        order({
          state: 'RECONCILED',
          actualAmountOut: parseEther('0.00095'),
          quotedAmountOut: parseEther('0.001'),
        }),
      ) // 5% sell tax
    const engine = new ProbeEngine({ executor: { execute }, market, probeStore, agentId: 'a' })

    const result = await engine.runProbe(input())
    expect(result.passed).toBe(true)
    expect(result.measuredBuyTaxBps).toBeCloseTo(500, 0) // 5%
    expect(result.measuredSellTaxBps).toBeCloseTo(500, 0)
    expect(probeStore.hasPassed(TOKEN)).toBe(true)

    // sell amount = 50% of the ACTUAL 950 received, not the quoted 1000
    const sellCall = execute.mock.calls[1]![0]
    expect(sellCall.amountIn).toBe(parseEther('475')) // 950 * 0.5
  })

  it('sell size defaults to 50% of the probe config, and is configurable', async () => {
    const probeStore = new ProbeStore(':memory:')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.001'))
    const execute = vi
      .fn()
      .mockResolvedValueOnce(order({ state: 'RECONCILED', actualAmountOut: parseEther('1000') }))
      .mockResolvedValueOnce(order({ state: 'RECONCILED', actualAmountOut: parseEther('0.001') }))
    const engine = new ProbeEngine({
      executor: { execute },
      market,
      probeStore,
      agentId: 'a',
      config: { probeSellFraction: 0.25 },
    })

    await engine.runProbe(input())
    const sellCall = execute.mock.calls[1]![0]
    expect(sellCall.amountIn).toBe(parseEther('250')) // 1000 * 0.25
  })
})
