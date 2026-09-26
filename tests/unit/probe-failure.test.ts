import { describe, expect, it } from 'vitest'
import { classifyProbeFailure } from '../../src/execution/probe-failure.js'

describe('classifyProbeFailure', () => {
  it.each([
    ['probe buy failed: receipt wait timed out after 120000ms', 'TEMPORARY_INFRA_FAILURE'],
    ['probe sell failed: RPC error 429 too many requests', 'TEMPORARY_INFRA_FAILURE'],
    ['probe buy failed: ECONNRESET', 'TEMPORARY_INFRA_FAILURE'],
    ['probe sell failed: provider unavailable', 'TEMPORARY_INFRA_FAILURE'],
    ['probe buy failed: fetch failed', 'TEMPORARY_INFRA_FAILURE'],
  ] as const)('%s -> %s', (reason, expected) => {
    expect(classifyProbeFailure(reason)).toBe(expected)
  })

  it.each([
    ['no buy route at probe size', 'MARKET_FAILURE'],
    ['probe sell quote failed — insufficient liquidity to size back', 'MARKET_FAILURE'],
    ['skip: excessive price impact at this size', 'MARKET_FAILURE'],
    ['skip: abnormal current volatility', 'MARKET_FAILURE'],
  ] as const)('%s -> %s', (reason, expected) => {
    expect(classifyProbeFailure(reason)).toBe(expected)
  })

  it.each([
    [
      'probe sell quote failed — cannot sell back despite a clean buy (honeypot signature)',
      'PERMANENT_TOKEN_FAILURE',
    ],
    ['probe buy failed: transaction reverted on-chain', 'PERMANENT_TOKEN_FAILURE'],
    ['probe sell failed: transaction reverted on-chain', 'PERMANENT_TOKEN_FAILURE'],
    ['probe buy failed: blacklisted by contract owner', 'PERMANENT_TOKEN_FAILURE'],
    ['probe sell failed: transfer tax exceeds expected amount', 'PERMANENT_TOKEN_FAILURE'],
    ['probe buy failed: FAILED', 'PERMANENT_TOKEN_FAILURE'], // no .error, just the terminal state — unrecognized, defaults safe
  ] as const)('%s -> %s', (reason, expected) => {
    expect(classifyProbeFailure(reason)).toBe(expected)
  })

  it('an infra pattern takes precedence over a market pattern appearing in the same message', () => {
    // "no route" (market-ish wording) alongside an explicit timeout — the
    // failure is genuinely about the RPC call not resolving, not the market.
    expect(classifyProbeFailure('no route: request timed out')).toBe('TEMPORARY_INFRA_FAILURE')
  })
})
