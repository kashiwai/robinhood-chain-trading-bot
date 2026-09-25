import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { classifyTransfer, subjectWallet } from '../../src/intelligence/classify.js'

const POOL = '0x1111111111111111111111111111111111111a' as Address
const ROUTER = '0x2222222222222222222222222222222222222b' as Address
const WALLET_A = '0x3333333333333333333333333333333333333c' as Address
const WALLET_B = '0x4444444444444444444444444444444444444d' as Address
const AGGREGATOR = '0x5555555555555555555555555555555555555e' as Address // NOT in our dex set — the known blind spot

const DEX = new Set([POOL.toLowerCase(), ROUTER.toLowerCase()])

describe('classifyTransfer — the fixture set Level 3 asks for', () => {
  it('pool -> wallet is a buy', () => {
    expect(classifyTransfer({ from: POOL, to: WALLET_A }, DEX)).toBe('buy')
  })

  it('router -> wallet is a buy (router-mediated fill)', () => {
    expect(classifyTransfer({ from: ROUTER, to: WALLET_A }, DEX)).toBe('buy')
  })

  it('wallet -> pool is a sell', () => {
    expect(classifyTransfer({ from: WALLET_A, to: POOL }, DEX)).toBe('sell')
  })

  it('wallet -> wallet is a transfer, not a trade', () => {
    expect(classifyTransfer({ from: WALLET_A, to: WALLET_B }, DEX)).toBe('transfer')
  })

  it('pool -> pool (e.g. an internal LP rebalance) is a transfer — neither side is "the wallet"', () => {
    expect(classifyTransfer({ from: POOL, to: ROUTER }, DEX)).toBe('transfer')
  })

  // ── documented misclassification cases (classify.ts's doc comment) ────────

  it(
    'KNOWN BLIND SPOT (undercount direction): wallet -> untracked aggregator reads as a plain ' +
      'transfer, not the first leg of a trade — the fail-safe direction, since it drops a real trade ' +
      'from stats rather than fabricating a wrong one',
    () => {
      expect(classifyTransfer({ from: WALLET_A, to: AGGREGATOR }, DEX)).toBe('transfer')
    },
  )

  it(
    'KNOWN BLIND SPOT (mis-attribution direction): the matching aggregator -> pool leg IS classified ' +
      'as a sell, but subjectWallet attributes it to the aggregator CONTRACT, not the real end user — a ' +
      'multi-hop trade through an unrecognized router silently credits/debits the wrong address',
    () => {
      expect(classifyTransfer({ from: AGGREGATOR, to: POOL }, DEX)).toBe('sell')
      expect(subjectWallet({ from: AGGREGATOR, to: POOL }, 'sell')).toBe(AGGREGATOR) // wrong wallet, real limitation
    },
  )

  it('a CEX withdrawal (any wallet address, no special marker) reads as a transfer, correctly — it is not a DEX trade', () => {
    const cexHotWallet = '0x6666666666666666666666666666666666666f' as Address
    expect(classifyTransfer({ from: cexHotWallet, to: WALLET_A }, DEX)).toBe('transfer')
  })

  it('is case-insensitive on addresses (checksummed vs lowercase input)', () => {
    const poolUpper = POOL.toUpperCase().replace('0X', '0x') as Address
    expect(classifyTransfer({ from: poolUpper, to: WALLET_A }, DEX)).toBe('buy')
  })

  it('from === to (a zero-net rebate/no-op transfer some tokens emit) does not crash and returns a stable classification', () => {
    expect(classifyTransfer({ from: WALLET_A, to: WALLET_A }, DEX)).toBe('transfer')
    expect(classifyTransfer({ from: POOL, to: POOL }, DEX)).toBe('transfer') // fromIsDex && toIsDex -> neither buy nor sell condition fires
  })
})

describe('subjectWallet', () => {
  it('a buy attaches to the recipient', () => {
    expect(subjectWallet({ from: POOL, to: WALLET_A }, 'buy')).toBe(WALLET_A)
  })

  it('a sell attaches to the sender', () => {
    expect(subjectWallet({ from: WALLET_A, to: POOL }, 'sell')).toBe(WALLET_A)
  })

  it('a transfer has no trade subject', () => {
    expect(subjectWallet({ from: WALLET_A, to: WALLET_B }, 'transfer')).toBeNull()
  })
})
