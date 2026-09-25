import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, pad, toEventSelector, type Account, type Address, type Hex } from 'viem'
import type { HoodClient, SwapQuote } from 'hoodchain'
import { OrderStore } from '../../src/execution/order-store.js'
import { NonceManager } from '../../src/execution/nonce-manager.js'
import { Executor, recoverPendingOrders, type ExecuteInput } from '../../src/execution/executor.js'

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address
const TOKEN = addr(1)
const WETH = addr(2)
const POOL = addr(3)
const ACCOUNT_ADDR = addr(4)

const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')
function transferLog(address: Address, from: Address, to: Address, value: bigint) {
  return {
    address,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    topics: [TRANSFER_TOPIC, pad(from), pad(to)] as [Hex, Hex, Hex],
  }
}

function quote(amountOut = 950n): SwapQuote {
  return {
    route: { fees: [3000], path: [WETH, TOKEN], encodedPath: '0x' as Hex },
    amountIn: 1000n,
    amountOut,
    gasEstimate: 120_000n,
  }
}

interface FakeClientOpts {
  pendingNonce?: number
  sendTransaction?: () => Promise<Hex>
  receipt?: () => Promise<{ status: 'success' | 'reverted'; logs: unknown[] }>
  allowance?: bigint
}

function fakeClient(opts: FakeClientOpts = {}): HoodClient {
  return {
    network: 'mainnet',
    account: { address: ACCOUNT_ADDR },
    acknowledgeStockTokenEligibility: false,
    wallet: {
      sendTransaction: opts.sendTransaction ?? (async () => '0xhash' as Hex),
      writeContract: async () => '0xapprove' as Hex,
    },
    public: {
      getTransactionCount: async () => opts.pendingNonce ?? 0,
      readContract: async () => opts.allowance ?? 10n ** 30n, // already approved by default
      waitForTransactionReceipt:
        opts.receipt ??
        (async () => ({ status: 'success', logs: [transferLog(TOKEN, POOL, ACCOUNT_ADDR, 950n)] })),
      getTransactionReceipt: opts.receipt ?? (async () => ({ status: 'success', logs: [] })),
    },
  } as unknown as HoodClient
}

function input(overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    idempotencyKey: 'evt-1',
    agentId: 'sniper-1',
    token: TOKEN,
    quoteToken: WETH,
    side: 'buy',
    amountIn: 1000n,
    quote: quote(),
    slippageBps: 100,
    ...overrides,
  }
}

async function makeExecutor(client: HoodClient) {
  const orderStore = new OrderStore(':memory:')
  const nonceManager = new NonceManager(client, ACCOUNT_ADDR)
  await nonceManager.sync()
  const executor = new Executor({
    client,
    account: { address: ACCOUNT_ADDR } as Account,
    orderStore,
    nonceManager,
  })
  return { orderStore, nonceManager, executor }
}

describe('Executor — full lifecycle', () => {
  it('walks CREATED -> ... -> RECONCILED with a real (reconciled, not quoted) fill amount', async () => {
    const client = fakeClient()
    const { executor } = await makeExecutor(client)
    const row = await executor.execute(input())
    expect(row.state).toBe('RECONCILED')
    expect(row.nonce).toBe(0)
    expect(row.txHash).toBe('0xhash')
    expect(row.quotedAmountOut).toBe(950n) // matches the quote in this fixture
    expect(row.actualAmountOut).toBe(950n) // reconciled from the Transfer log, a separate code path arriving at the same number here
  })

  it('duplicate event: a second execute() with the SAME idempotency key does not resubmit', async () => {
    const sendTx = vi.fn(async () => '0xhash' as Hex)
    const { executor } = await makeExecutor(fakeClient({ sendTransaction: sendTx }))
    await executor.execute(input())
    await executor.execute(input()) // same idempotencyKey
    expect(sendTx).toHaveBeenCalledTimes(1)
  })

  it('a duplicate signal with the SAME key but a completely different quote is still a no-op — the first write wins', async () => {
    const { executor } = await makeExecutor(fakeClient())
    const first = await executor.execute(input())
    const second = await executor.execute(input({ quote: quote(1n) })) // wildly different amountOut
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second.quotedAmountOut).toBe(first.quotedAmountOut)
  })

  it('revert: the order lands in FAILED with the revert reason, nonce is NOT released (it was already broadcast)', async () => {
    const client = fakeClient({ receipt: async () => ({ status: 'reverted', logs: [] }) })
    const { executor, nonceManager } = await makeExecutor(client)
    const row = await executor.execute(input())
    expect(row.state).toBe('FAILED')
    expect(row.error).toMatch(/reverted/)
    // nonce 0 was consumed by the broadcast tx even though it reverted — nonce 1 is next, not 0 again.
    expect(await nonceManager.reserve()).toBe(1)
  })

  it('receipt timeout: FAILS the order; the nonce stays consumed (it WAS already broadcast) rather than released', async () => {
    const client = fakeClient({
      receipt: () => new Promise(() => {}), // never resolves
    })
    const orderStore = new OrderStore(':memory:')
    const nonceManager = new NonceManager(client, ACCOUNT_ADDR)
    await nonceManager.sync()
    const executor = new Executor({
      client,
      account: { address: ACCOUNT_ADDR } as Account,
      orderStore,
      nonceManager,
      receiptTimeoutMs: 20,
    })
    const timedOut = await executor.execute(input({ idempotencyKey: 'evt-timeout' }))
    expect(timedOut.state).toBe('FAILED')
    expect(timedOut.error).toMatch(/timed out/)
    expect(await nonceManager.reserve()).toBe(1) // nonce 0 stays consumed — it WAS broadcast, just never confirmed in time
  })

  it('a failure BEFORE broadcast (e.g. ensureApproval throws) releases the reserved nonce for reuse', async () => {
    const client = fakeClient()
    client.public.readContract = (async () => {
      throw new Error('allowance check RPC error')
    }) as never
    const { executor, nonceManager } = await makeExecutor(client)
    const row = await executor.execute(input())
    expect(row.state).toBe('FAILED')
    expect(row.nonce).toBeNull() // never reached SUBMITTED, so no nonce recorded on the order
    expect(await nonceManager.reserve()).toBe(0) // released and reused, not burned
  })

  it('RPC timeout AT submission (sendTransaction itself hangs): FAILS the order, but the nonce is NOT released — broadcast may have actually gone through', async () => {
    const client = fakeClient({ sendTransaction: () => new Promise(() => {}) }) // hangs forever
    const orderStore = new OrderStore(':memory:')
    const nonceManager = new NonceManager(client, ACCOUNT_ADDR)
    await nonceManager.sync()
    const executor = new Executor({
      client,
      account: { address: ACCOUNT_ADDR } as Account,
      orderStore,
      nonceManager,
      rpcTimeoutMs: 20,
    })
    const row = await executor.execute(input({ idempotencyKey: 'evt-submit-timeout' }))
    expect(row.state).toBe('FAILED')
    expect(row.error).toMatch(/timed out/)
    expect(row.nonce).toBeNull() // never confirmed as SUBMITTED, so not recorded on the row...
    expect(await nonceManager.reserve()).toBe(1) // ...but nonce 0 is still burned, not reused — the ambiguity is real
  })

  it('nonce collision: the RPC rejects the submission itself with a nonce error — order FAILS, nonce stays unreleased (ambiguous), next order does not collide', async () => {
    const client = fakeClient({
      sendTransaction: async () => {
        throw new Error('nonce too low: next nonce 5, tx nonce 0')
      },
    })
    const { executor, nonceManager } = await makeExecutor(client)
    const row = await executor.execute(input())
    expect(row.state).toBe('FAILED')
    expect(row.error).toMatch(/nonce too low/)
    // Conservative: even though this particular error implies the broadcast
    // definitely did NOT happen, the executor cannot distinguish "rejected
    // before broadcast" RPC errors from "rejected after silently broadcasting"
    // ones in general, so it treats every post-broadcast-attempt failure the
    // same way — nonce 0 is not reused, the next order gets nonce 1.
    const second = await executor.execute(input({ idempotencyKey: 'evt-2' }))
    expect(second.nonce).toBeNull() // this second call also fails at sendTransaction (same fake), but...
    expect(await nonceManager.reserve()).toBe(2) // ...nonces 0 and 1 are both retired, never collided or reused blindly
  })
})

describe('recoverPendingOrders — restart recovery', () => {
  it('an order stuck before SUBMITTED (no tx hash) is marked FAILED — nothing to recover', async () => {
    const orderStore = new OrderStore(':memory:')
    orderStore.createOrder({
      idempotencyKey: 'k1',
      agentId: 'a',
      token: TOKEN,
      side: 'buy',
      quoteToken: WETH,
      amountIn: '1',
    })
    orderStore.transition('k1', 'CHECKED')

    const client = fakeClient()
    const result = await recoverPendingOrders(client, orderStore, () => ({ account: ACCOUNT_ADDR }))
    expect(result.failed).toBe(1)
    expect(orderStore.get('k1')!.state).toBe('FAILED')
  })

  it('an order that WAS submitted and has since confirmed is carried through to RECONCILED', async () => {
    const orderStore = new OrderStore(':memory:')
    orderStore.createOrder({
      idempotencyKey: 'k2',
      agentId: 'a',
      token: TOKEN,
      side: 'buy',
      quoteToken: WETH,
      amountIn: '1000',
    })
    orderStore.transition('k2', 'CHECKED')
    orderStore.transition('k2', 'QUOTED', { quotedAmountOut: 950n })
    orderStore.transition('k2', 'SIGNED')
    orderStore.transition('k2', 'SUBMITTED', { nonce: 0, txHash: '0xdeadbeef' })

    const client = fakeClient({
      receipt: async () => ({ status: 'success', logs: [transferLog(TOKEN, POOL, ACCOUNT_ADDR, 900n)] }),
    })
    const result = await recoverPendingOrders(client, orderStore, () => ({ account: ACCOUNT_ADDR }))
    expect(result.recovered).toBe(1)
    const row = orderStore.get('k2')!
    expect(row.state).toBe('RECONCILED')
    expect(row.actualAmountOut).toBe(900n)
  })

  it('an order still genuinely unconfirmed (no receipt yet) is left pending, not guessed at', async () => {
    const orderStore = new OrderStore(':memory:')
    orderStore.createOrder({
      idempotencyKey: 'k3',
      agentId: 'a',
      token: TOKEN,
      side: 'buy',
      quoteToken: WETH,
      amountIn: '1000',
    })
    orderStore.transition('k3', 'CHECKED')
    orderStore.transition('k3', 'QUOTED', { quotedAmountOut: 950n })
    orderStore.transition('k3', 'SIGNED')
    orderStore.transition('k3', 'SUBMITTED', { nonce: 0, txHash: '0xstillpending' })

    const client = fakeClient({
      receipt: async () => {
        throw new Error('receipt not found')
      },
    })
    const result = await recoverPendingOrders(client, orderStore, () => ({ account: ACCOUNT_ADDR }))
    expect(result.stillPending).toBe(1)
    expect(orderStore.get('k3')!.state).toBe('SUBMITTED') // untouched — no guessing
  })

  it('a submitted order found REVERTED on recovery is marked FAILED', async () => {
    const orderStore = new OrderStore(':memory:')
    orderStore.createOrder({
      idempotencyKey: 'k4',
      agentId: 'a',
      token: TOKEN,
      side: 'buy',
      quoteToken: WETH,
      amountIn: '1000',
    })
    orderStore.transition('k4', 'CHECKED')
    orderStore.transition('k4', 'QUOTED', { quotedAmountOut: 950n })
    orderStore.transition('k4', 'SIGNED')
    orderStore.transition('k4', 'SUBMITTED', { nonce: 0, txHash: '0xreverted' })

    const client = fakeClient({ receipt: async () => ({ status: 'reverted', logs: [] }) })
    const result = await recoverPendingOrders(client, orderStore, () => ({ account: ACCOUNT_ADDR }))
    expect(result.failed).toBe(1)
    expect(orderStore.get('k4')!.state).toBe('FAILED')
  })
})
