import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { toFunctionSelector } from 'viem'
import type { HoodClient } from 'hoodchain'
import { scanContractRisk } from '../../src/security/contract-risk.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const OWNER = '0x2222222222222222222222222222222222222b' as Address

const MINT_SELECTOR = toFunctionSelector('mint(address,uint256)').slice(2)
const PAUSE_SELECTOR = toFunctionSelector('pause()').slice(2)
const BLACKLIST_SELECTOR = toFunctionSelector('blacklist(address)').slice(2)

interface FakeOpts {
  code?: Hex
  implSlot?: Hex
  owner?: Address | null // null = readContract throws (function doesn't exist)
  paused?: boolean | null
  mintReverts?: boolean // what the outsider mint probe call does
}

function fakeClient(opts: FakeOpts): HoodClient {
  return {
    public: {
      getCode: async ({ address }: { address: Address }) =>
        address.toLowerCase() === TOKEN.toLowerCase() ? (opts.code ?? '0x6080604052') : '0xfe', // implementation code, if any
      getStorageAt: async () => opts.implSlot ?? '0x' + '0'.repeat(64),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'owner') {
          if (opts.owner === undefined) throw new Error('no owner()')
          if (opts.owner === null) return '0x0000000000000000000000000000000000000000'
          return opts.owner
        }
        if (functionName === 'paused') {
          if (opts.paused === undefined || opts.paused === null) throw new Error('no paused()')
          return opts.paused
        }
        throw new Error('unexpected call')
      },
      call: async () => {
        if (opts.mintReverts === false) return { data: '0x' as Hex } // succeeds -> anyone can mint
        throw new Error('reverted') // default: reverts -> access controlled
      },
    },
  } as unknown as HoodClient
}

describe('scanContractRisk', () => {
  it('a clean contract (no selectors, no owner, no proxy) scores 0 with no flags', async () => {
    const client = fakeClient({ code: '0x6080604052' })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.riskScore).toBe(0)
    expect(report.riskFlags).toHaveLength(0)
    expect(report.isProxy).toBe(false)
  })

  it('no bytecode at all is the maximum risk score, unconditionally', async () => {
    const client = fakeClient({ code: '0x' })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.hasCode).toBe(false)
    expect(report.riskScore).toBe(100)
  })

  it('an active (non-renounced) owner is flagged', async () => {
    const client = fakeClient({ code: '0x6080604052', owner: OWNER })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.ownerAddress).toBe(OWNER)
    expect(report.ownerRenounced).toBe(false)
    expect(report.riskFlags.some((f) => f.includes('active owner'))).toBe(true)
  })

  it('owner() returning the zero address is read as renounced, not an active owner', async () => {
    const client = fakeClient({ code: '0x6080604052', owner: null })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.ownerRenounced).toBe(true)
    expect(report.riskFlags.some((f) => f.includes('active owner'))).toBe(false)
  })

  it('CRITICAL: mint() present in bytecode AND callable by an outsider scores highest among non-missing-code cases', async () => {
    const code = ('0x6080604052' + MINT_SELECTOR) as Hex
    const client = fakeClient({ code, mintReverts: false })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.hasMintSelector).toBe(true)
    expect(report.mintCallableByOutsider).toBe(true)
    expect(report.riskFlags.some((f) => f.includes('CRITICAL') && f.includes('mint'))).toBe(true)
    expect(report.riskScore).toBeGreaterThanOrEqual(50)
  })

  it('mint() present but access-controlled (probe reverts) is a real but lesser finding', async () => {
    const code = ('0x6080604052' + MINT_SELECTOR) as Hex
    const client = fakeClient({ code, mintReverts: true, owner: OWNER })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.mintCallableByOutsider).toBe(false)
    expect(report.riskFlags.some((f) => f.includes('CRITICAL'))).toBe(false)
    expect(report.riskFlags.some((f) => f.includes('mint() exists and is access-controlled'))).toBe(true)
  })

  it('the mint probe is never attempted when the selector is absent from bytecode', async () => {
    const client = fakeClient({ code: '0x6080604052' })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.hasMintSelector).toBe(false)
    expect(report.mintCallableByOutsider).toBeNull()
  })

  it('CRITICAL: a currently-paused contract is flagged regardless of selector presence', async () => {
    const client = fakeClient({ code: '0x6080604052', paused: true })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.isPaused).toBe(true)
    expect(report.riskFlags.some((f) => f.includes('CRITICAL') && f.includes('paused'))).toBe(true)
  })

  it('a blacklist-style selector in bytecode is flagged as an unconfirmed (selector-only) signal', async () => {
    const code = ('0x6080604052' + BLACKLIST_SELECTOR) as Hex
    const client = fakeClient({ code })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.hasBlacklistSelector).toBe(true)
    expect(report.riskFlags.some((f) => f.includes('blacklist'))).toBe(true)
  })

  it('an EIP-1967 proxy is detected and its implementation address is surfaced', async () => {
    const implAddr = `0x${'9f'.padStart(40, '9')}`
    const implSlot = ('0x' + implAddr.slice(2).padStart(64, '0')) as Hex
    const client = fakeClient({ code: '0x6080604052', implSlot })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.isProxy).toBe(true)
    expect(report.implementationAddress?.toLowerCase()).toBe(implAddr.toLowerCase())
    expect(report.riskFlags.some((f) => f.includes('upgradeable proxy'))).toBe(true)
  })

  it('a pause() selector in bytecode is flagged even when the contract is not CURRENTLY paused', async () => {
    const code = ('0x6080604052' + PAUSE_SELECTOR) as Hex
    const client = fakeClient({ code, paused: false })
    const report = await scanContractRisk(client, TOKEN)
    expect(report.hasPauseSelector).toBe(true)
    expect(report.isPaused).toBe(false)
    expect(report.riskFlags.some((f) => f.includes('has pause capability'))).toBe(true)
    expect(report.riskFlags.some((f) => f.includes('CRITICAL'))).toBe(false)
  })
})
