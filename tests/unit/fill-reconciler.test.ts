import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, pad, toEventSelector, type Address, type Hex, type Log } from 'viem'
import { reconcileFill } from '../../src/execution/fill-reconciler.js'

const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')

// `pad()`/`decodeEventLog` enforce the real 20-byte address length, so unlike
// most other test files in this repo (which treat addresses as opaque
// strings and tolerate a hand-typed literal a digit short), fixtures here
// MUST be exactly 40 hex chars — generated, not hand-typed, to guarantee it.
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const TOKEN = addr(1)
const OTHER_TOKEN = addr(2)
const POOL = addr(3)
const ACCOUNT = addr(4)
const OTHER_ACCOUNT = addr(5)

function transferLog(address: Address, from: Address, to: Address, value: bigint): Log {
  const data = encodeAbiParameters([{ type: 'uint256' }], [value])
  const topics = [TRANSFER_TOPIC, pad(from), pad(to)] as [Hex, Hex, Hex]
  return { address, data, topics, blockNumber: 1n, transactionHash: '0xabc', logIndex: 0 } as unknown as Log
}

describe('reconcileFill', () => {
  it('reads the actual received amount from the receipt Transfer log, not the quote', () => {
    const logs = [transferLog(TOKEN, POOL, ACCOUNT, 950n)]
    const result = reconcileFill(logs, TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualAmountOut).toBe(950n)
    expect(result.actualSlippageBps).toBe(500) // (1000-950)/1000 = 5% = 500bps
  })

  it('sums multiple Transfer logs to the account (e.g. a fee-split swap)', () => {
    const logs = [transferLog(TOKEN, POOL, ACCOUNT, 800n), transferLog(TOKEN, POOL, ACCOUNT, 100n)]
    const result = reconcileFill(logs, TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualAmountOut).toBe(900n)
  })

  it('ignores transfers of a different token', () => {
    const logs = [transferLog(OTHER_TOKEN, POOL, ACCOUNT, 500n)]
    const result = reconcileFill(logs, TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualAmountOut).toBeNull()
  })

  it('ignores transfers of the right token but to a different recipient', () => {
    const logs = [transferLog(TOKEN, POOL, OTHER_ACCOUNT, 900n)]
    const result = reconcileFill(logs, TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualAmountOut).toBeNull()
  })

  it('no matching logs at all -> null fill, not zero (zero would look like "received nothing", null means "could not determine")', () => {
    const result = reconcileFill([], TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualAmountOut).toBeNull()
    expect(result.actualPrice).toBeNull()
  })

  it('an actual fill that beats the quote gives NEGATIVE slippage bps (positive surprise)', () => {
    const logs = [transferLog(TOKEN, POOL, ACCOUNT, 1050n)]
    const result = reconcileFill(logs, TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualSlippageBps).toBe(-500)
  })

  it('a non-Transfer log on the same token address does not crash and is skipped', () => {
    const weirdLog: Log = {
      address: TOKEN,
      data: '0x1234',
      topics: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
      blockNumber: 1n,
      transactionHash: '0xabc',
      logIndex: 0,
    } as unknown as Log
    const logs = [weirdLog, transferLog(TOKEN, POOL, ACCOUNT, 900n)]
    const result = reconcileFill(logs, TOKEN, ACCOUNT, 1000n, 100n)
    expect(result.actualAmountOut).toBe(900n)
  })
})
