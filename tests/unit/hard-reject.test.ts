import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { evaluateHardReject, type HardRejectInput } from '../../src/security/hard-reject.js'
import type { ContractRiskReport } from '../../src/security/contract-risk.js'
import type { SellabilityResult } from '../../src/security/sellability.js'
import type { LiquidityReport } from '../../src/security/liquidity.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address

function cleanRisk(overrides: Partial<ContractRiskReport> = {}): ContractRiskReport {
  return {
    address: TOKEN,
    hasCode: true,
    isProxy: false,
    implementationAddress: null,
    ownerAddress: null,
    ownerRenounced: true,
    hasMintSelector: false,
    mintCallableByOutsider: null,
    isPaused: false,
    hasPauseSelector: false,
    hasBlacklistSelector: false,
    hasMaxTxWalletSelectors: false,
    riskFlags: [],
    riskScore: 0,
    ...overrides,
  }
}

function cleanSellability(overrides: Partial<SellabilityResult> = {}): SellabilityResult {
  return {
    token: TOKEN,
    buyAmountOut: 1000n,
    sellAmountOut: 980n,
    roundTripRetention: 0.98,
    sellable: true,
    reason: 'clean',
    ...overrides,
  }
}

function cleanLiquidity(overrides: Partial<LiquidityReport> = {}): LiquidityReport {
  return {
    token: TOKEN,
    tiers: [],
    liquidityScore: 90,
    ...overrides,
  }
}

function input(overrides: Partial<HardRejectInput> = {}): HardRejectInput {
  return {
    contractRisk: cleanRisk(),
    sellability: cleanSellability(),
    liquidity: cleanLiquidity(),
    ...overrides,
  }
}

describe('evaluateHardReject — the six named conditions', () => {
  it('a fully clean token is never rejected', () => {
    expect(evaluateHardReject(input())).toEqual({ rejected: false, reasons: [] })
  })

  it('sell simulation failure rejects', () => {
    const v = evaluateHardReject(
      input({
        sellability: cleanSellability({
          sellable: false,
          reason: 'no sell route back — classic honeypot signature',
        }),
      }),
    )
    expect(v.rejected).toBe(true)
    expect(v.reasons[0]).toMatch(/sell simulation failure/)
  })

  it('extreme sell tax (below the 50% default threshold) rejects', () => {
    const v = evaluateHardReject(input({ sellability: cleanSellability({ roundTripRetention: 0.3 }) }))
    expect(v.rejected).toBe(true)
    expect(v.reasons[0]).toMatch(/extreme sell tax/)
  })

  it('a moderate (non-extreme) tax does NOT trip the extreme-tax reject', () => {
    const v = evaluateHardReject(input({ sellability: cleanSellability({ roundTripRetention: 0.7 }) }))
    expect(v.rejected).toBe(false)
  })

  it('blacklist selector present rejects', () => {
    const v = evaluateHardReject(input({ contractRisk: cleanRisk({ hasBlacklistSelector: true }) }))
    expect(v.rejected).toBe(true)
    expect(v.reasons.some((r) => r.includes('blacklist'))).toBe(true)
  })

  it('unbounded mint (outsider-callable) rejects', () => {
    const v = evaluateHardReject(
      input({ contractRisk: cleanRisk({ hasMintSelector: true, mintCallableByOutsider: true }) }),
    )
    expect(v.rejected).toBe(true)
    expect(v.reasons.some((r) => r.includes('unbounded mint'))).toBe(true)
  })

  it('owner-gated mint with an active owner rejects too (cannot confirm a supply cap from bytecode alone)', () => {
    const owner = '0x2222222222222222222222222222222222222b' as Address
    const v = evaluateHardReject(
      input({
        contractRisk: cleanRisk({
          hasMintSelector: true,
          mintCallableByOutsider: false,
          ownerAddress: owner,
          ownerRenounced: false,
        }),
      }),
    )
    expect(v.rejected).toBe(true)
    expect(v.reasons.some((r) => r.includes('unbounded owner mint'))).toBe(true)
  })

  it('owner-gated mint with a RENOUNCED owner does NOT reject', () => {
    const v = evaluateHardReject(
      input({
        contractRisk: cleanRisk({
          hasMintSelector: true,
          mintCallableByOutsider: false,
          ownerRenounced: true,
          ownerAddress: null,
        }),
      }),
    )
    expect(v.rejected).toBe(false)
  })

  it('liquidity below threshold rejects', () => {
    const v = evaluateHardReject(input({ liquidity: cleanLiquidity({ liquidityScore: 5 }) }))
    expect(v.rejected).toBe(true)
    expect(v.reasons.some((r) => r.includes('liquidity below threshold'))).toBe(true)
  })

  it('critical proxy risk (upgradeable + active admin) rejects', () => {
    const owner = '0x2222222222222222222222222222222222222b' as Address
    const v = evaluateHardReject(
      input({ contractRisk: cleanRisk({ isProxy: true, ownerAddress: owner, ownerRenounced: false }) }),
    )
    expect(v.rejected).toBe(true)
    expect(v.reasons.some((r) => r.includes('critical proxy risk'))).toBe(true)
  })

  it('an upgradeable proxy WITHOUT an active admin (renounced) does not trip the proxy condition', () => {
    const v = evaluateHardReject(
      input({ contractRisk: cleanRisk({ isProxy: true, ownerRenounced: true, ownerAddress: null }) }),
    )
    expect(v.rejected).toBe(false)
  })

  it('shadow mode records every reason but never rejects', () => {
    const v = evaluateHardReject(input({ sellability: cleanSellability({ sellable: false, reason: 'x' }) }), {
      mode: 'shadow',
    })
    expect(v.rejected).toBe(false)
    expect(v.reasons.length).toBeGreaterThan(0)
  })

  it('multiple simultaneous violations all get recorded, not just the first', () => {
    const v = evaluateHardReject(
      input({
        sellability: cleanSellability({ sellable: false, reason: 'no route' }),
        liquidity: cleanLiquidity({ liquidityScore: 0 }),
      }),
    )
    expect(v.reasons.length).toBe(2)
  })

  it('thresholds are configurable — a stricter minLiquidityScore rejects a token the default would pass', () => {
    const okAtDefault = evaluateHardReject(input({ liquidity: cleanLiquidity({ liquidityScore: 30 }) }))
    const strict = evaluateHardReject(input({ liquidity: cleanLiquidity({ liquidityScore: 30 }) }), {
      minLiquidityScore: 50,
    })
    expect(okAtDefault.rejected).toBe(false)
    expect(strict.rejected).toBe(true)
  })
})
