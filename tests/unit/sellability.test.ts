import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { parseEther } from 'viem'
import { checkSellability } from '../../src/security/sellability.js'
import { FakeMarket } from './helpers/fake-market.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address

describe('checkSellability', () => {
  it('no buy route at all -> not sellable', async () => {
    const market = new FakeMarket()
    const result = await checkSellability(market, TOKEN, WETH, parseEther('0.01'))
    expect(result.sellable).toBe(false)
    expect(result.reason).toMatch(/no liquid buy route/)
  })

  it('honeypot: buys fine, cannot sell back at all', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    const result = await checkSellability(market, TOKEN, WETH, parseEther('0.01'))
    expect(result.sellable).toBe(false)
    expect(result.reason).toMatch(/honeypot/)
  })

  it('a clean round trip reports high retention and sellable=true', async () => {
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), (amountIn * 98n) / 100n)
    const result = await checkSellability(market, TOKEN, WETH, amountIn)
    expect(result.sellable).toBe(true)
    expect(result.roundTripRetention).toBeCloseTo(0.98, 6)
  })

  it('an extreme-tax token reports low retention but is still technically "sellable" (the hard-reject layer judges the threshold)', async () => {
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), (amountIn * 20n) / 100n) // 80% lost
    const result = await checkSellability(market, TOKEN, WETH, amountIn)
    expect(result.sellable).toBe(true)
    expect(result.roundTripRetention).toBeCloseTo(0.2, 6)
  })
})
