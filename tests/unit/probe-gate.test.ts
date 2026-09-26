import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { ProbeGate } from '../../src/execution/probe-gate.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address

function checkInput() {
  return { quoteToken: WETH, quoteTokenUsdPrice: 2000, quoteDecimals: 18, slippageBps: 100 }
}

function fakeStore(
  overrides: Partial<{ isBlacklisted: boolean; hasPassed: boolean; isQuarantined: boolean }> = {},
) {
  return {
    isBlacklisted: () => overrides.isBlacklisted ?? false,
    hasPassed: () => overrides.hasPassed ?? false,
    isQuarantined: () => overrides.isQuarantined ?? false,
  }
}

describe('ProbeGate', () => {
  it('a blacklisted token short-circuits without running a new probe', async () => {
    const runProbe = vi.fn()
    const gate = new ProbeGate({ runProbe }, fakeStore({ isBlacklisted: true }))
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('blacklisted')
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('an already-passed token short-circuits as already_passed without re-spending', async () => {
    const runProbe = vi.fn()
    const gate = new ProbeGate({ runProbe }, fakeStore({ hasPassed: true }))
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('already_passed')
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('a quarantined token (cooldown not yet elapsed) short-circuits without running a new probe', async () => {
    const runProbe = vi.fn()
    const gate = new ProbeGate({ runProbe }, fakeStore({ isQuarantined: true }))
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('quarantined')
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('an unseen token runs a real probe; a pass reports action=probed (not already_passed) for THIS tick', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: true,
      reason: 'probe passed',
      measuredBuyTaxBps: 0,
      measuredSellTaxBps: 0,
      failureClass: null,
    })
    const gate = new ProbeGate({ runProbe }, fakeStore())
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('probed')
    expect(runProbe).toHaveBeenCalledWith({ token: TOKEN, ...checkInput() }, expect.any(Number))
  })

  it('an unseen token whose probe fails with a PERMANENT_TOKEN_FAILURE reports action=blacklisted', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: false,
      reason: 'probe sell failed: reverted',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      failureClass: 'PERMANENT_TOKEN_FAILURE',
    })
    const gate = new ProbeGate({ runProbe }, fakeStore())
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('blacklisted')
    expect(result.reason).toMatch(/probe sell failed/)
  })

  it('an unseen token whose probe fails with a TEMPORARY_INFRA_FAILURE reports action=quarantined, not blacklisted', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: false,
      reason: 'probe buy failed: receipt wait timed out after 120000ms',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      failureClass: 'TEMPORARY_INFRA_FAILURE',
    })
    const gate = new ProbeGate({ runProbe }, fakeStore())
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('quarantined')
  })

  it('an unseen token whose probe fails with a MARKET_FAILURE reports action=quarantined, not blacklisted', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: false,
      reason: 'no buy route at probe size',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      failureClass: 'MARKET_FAILURE',
    })
    const gate = new ProbeGate({ runProbe }, fakeStore())
    const result = await gate.check(TOKEN, checkInput())
    expect(result.action).toBe('quarantined')
  })

  it('sends PROBE_START before running, then PROBE_PASS on success', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: true,
      reason: 'probe passed',
      measuredBuyTaxBps: 0,
      measuredSellTaxBps: 0,
      failureClass: null,
    })
    const send = vi.fn().mockResolvedValue(undefined)
    const gate = new ProbeGate({ runProbe }, fakeStore(), 30 * 60_000, { send })
    await gate.check(TOKEN, checkInput())
    expect(send).toHaveBeenCalledWith('PROBE_START', expect.any(String))
    expect(send).toHaveBeenCalledWith('PROBE_PASS', expect.any(String))
    expect(send).not.toHaveBeenCalledWith('PROBE_FAIL', expect.anything())
  })

  it('sends PROBE_FAIL (not PROBE_PASS) when the probe fails', async () => {
    const runProbe = vi.fn().mockResolvedValue({
      token: TOKEN,
      passed: false,
      reason: 'no buy route at probe size',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      failureClass: 'MARKET_FAILURE',
    })
    const send = vi.fn().mockResolvedValue(undefined)
    const gate = new ProbeGate({ runProbe }, fakeStore(), 30 * 60_000, { send })
    await gate.check(TOKEN, checkInput())
    expect(send).toHaveBeenCalledWith('PROBE_FAIL', expect.any(String))
    expect(send).not.toHaveBeenCalledWith('PROBE_PASS', expect.anything())
  })

  it('a short-circuited check (blacklisted/passed/quarantined) never sends PROBE_START — no probe actually ran', async () => {
    const runProbe = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    const gate = new ProbeGate({ runProbe }, fakeStore({ isBlacklisted: true }), 30 * 60_000, { send })
    await gate.check(TOKEN, checkInput())
    expect(send).not.toHaveBeenCalledWith('PROBE_START', expect.anything())
  })
})
