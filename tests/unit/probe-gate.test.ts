import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { ProbeGate } from '../../src/execution/probe-gate.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address

function checkInput() {
  return { quoteToken: WETH, quoteTokenUsdPrice: 2000, quoteDecimals: 18, slippageBps: 100 }
}

describe('ProbeGate', () => {
  it('a blacklisted token short-circuits without running a new probe', async () => {
    const runProbe = vi.fn()
    const gate = new ProbeGate({ runProbe }, { isBlacklisted: () => true, hasPassed: () => false })
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('blacklisted')
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('an already-passed token short-circuits as already_passed without re-spending', async () => {
    const runProbe = vi.fn()
    const gate = new ProbeGate({ runProbe }, { isBlacklisted: () => false, hasPassed: () => true })
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('already_passed')
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('an unseen token runs a real probe; a pass reports action=probed (not already_passed) for THIS tick', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: true,
      reason: 'probe passed',
      measuredBuyTaxBps: 0,
      measuredSellTaxBps: 0,
    })
    const gate = new ProbeGate({ runProbe }, { isBlacklisted: () => false, hasPassed: () => false })
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('probed')
    expect(runProbe).toHaveBeenCalledWith({ token: TOKEN, ...checkInput() })
  })

  it('an unseen token that fails its probe reports action=blacklisted', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: false,
      reason: 'probe sell failed: reverted',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
    })
    const gate = new ProbeGate({ runProbe }, { isBlacklisted: () => false, hasPassed: () => false })
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('blacklisted')
    expect(result.reason).toMatch(/probe sell failed/)
  })
})
