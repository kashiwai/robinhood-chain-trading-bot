import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { formatUnits, parseUnits } from 'viem'
import {
  computeExecutableLiquidity,
  scoreLiquidity,
  LIQUIDITY_PROBE_TIERS_USD,
} from '../../src/security/liquidity.js'
import { FakeMarket } from './helpers/fake-market.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address
const SPOT_USD = 0.01 // $0.01/token
const ETH_USD = 1 // pretend quote token is already USD-denominated for simplicity

describe('computeExecutableLiquidity', () => {
  it('queries every tier and reports zero impact for a perfectly deep, zero-slippage market', async () => {
    // FakeMarket's sellRoutes is a single fixed response per token, which can't represent "proceeds
    // scale proportionally with size" across 7 different tiers — use a proportional stub instead,
    // since this test specifically wants "flat/no slippage" as the baseline case.
    const proportionalMarket = {
      quoteSell: async (_token: Address, _quoteToken: Address, amount: bigint) => ({
        route: { fees: [3000], path: [], encodedPath: '0x' as const },
        amountIn: 0n,
        amountOut: parseUnits((Number(formatUnits(amount, 18)) * SPOT_USD).toFixed(6), 18),
        gasEstimate: 0n,
      }),
    }
    const report = await computeExecutableLiquidity(proportionalMarket, TOKEN, WETH, SPOT_USD, ETH_USD)
    expect(report.tiers).toHaveLength(LIQUIDITY_PROBE_TIERS_USD.length)
    for (const t of report.tiers) expect(t.impact).toBeCloseTo(0, 3)
    expect(report.liquidityScore).toBeCloseTo(100, 0)
  })

  it('a token with no sell route at any tier gets liquidityScore 0', async () => {
    const market = new FakeMarket() // no sellRoutes configured -> every quoteSell resolves null
    const report = await computeExecutableLiquidity(market, TOKEN, WETH, SPOT_USD, ETH_USD)
    expect(report.tiers.every((t) => t.impact === null)).toBe(true)
    expect(report.liquidityScore).toBe(0)
  })

  it('impact grows with tier size in a thin market (diminishing liquidity per unit size)', async () => {
    // Simulate a thin pool: proceeds grow sub-linearly with size (impact increases).
    const thinMarket = {
      quoteSell: async (_token: Address, _quoteToken: Address, amount: bigint) => {
        const tokenAmount = Number(formatUnits(amount, 18))
        const idealUsd = tokenAmount * SPOT_USD
        const actualUsd = idealUsd * Math.max(0, 1 - idealUsd / 2000) // impact grows with size
        return {
          route: { fees: [3000], path: [], encodedPath: '0x' as const },
          amountIn: 0n,
          amountOut: parseUnits(Math.max(0, actualUsd).toFixed(6), 18),
          gasEstimate: 0n,
        }
      },
    }
    const report = await computeExecutableLiquidity(thinMarket, TOKEN, WETH, SPOT_USD, ETH_USD)
    const impact10 = report.tiers.find((t) => t.usdTier === 10)!.impact!
    const impact1000 = report.tiers.find((t) => t.usdTier === 1000)!.impact!
    expect(impact1000).toBeGreaterThan(impact10)
  })
})

describe("scoreLiquidity — anchored to the spec's own example thresholds", () => {
  it('comfortably under the spec thresholds ($25<1%, $100<3%, $500<10%) scores near-perfect', () => {
    const score = scoreLiquidity([
      { usdTier: 25, impact: 0.001 }, // 10% of the 1% checkpoint
      { usdTier: 100, impact: 0.003 }, // 10% of the 3% checkpoint
      { usdTier: 500, impact: 0.01 }, // 10% of the 10% checkpoint
    ])
    expect(score).toBeGreaterThan(85)
  })

  it('sitting at HALF of each checkpoint scores at the midpoint (100 - the linear penalty)', () => {
    const score = scoreLiquidity([
      { usdTier: 25, impact: 0.005 },
      { usdTier: 100, impact: 0.015 },
      { usdTier: 500, impact: 0.05 },
    ])
    expect(score).toBeCloseTo(50, 0)
  })

  it('impact at or beyond each checkpoint drives that component to its floor', () => {
    const score = scoreLiquidity([
      { usdTier: 25, impact: 0.01 }, // exactly at the 1% checkpoint
      { usdTier: 100, impact: 0.03 }, // exactly at the 3% checkpoint
      { usdTier: 500, impact: 0.1 }, // exactly at the 10% checkpoint
    ])
    expect(score).toBeCloseTo(0, 0)
  })

  it('missing checkpoint data (no route at that size) is scored as the worst case for that component, not skipped', () => {
    const withData = scoreLiquidity([{ usdTier: 25, impact: 0.001 }])
    const withoutData = scoreLiquidity([])
    expect(withoutData).toBeLessThan(withData)
  })
})
