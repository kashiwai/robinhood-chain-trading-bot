import { buildSwapTx, ensureApproval, type HoodClient, type SwapQuote } from 'hoodchain'
import type { Account, Address } from 'viem'
import { OrderStore, type OrderRow } from './order-store.js'
import { NonceManager } from './nonce-manager.js'
import { reconcileFill } from './fill-reconciler.js'

export interface ExecutorOptions {
  client: HoodClient
  account: Account
  orderStore: OrderStore
  nonceManager: NonceManager
  onError?: (error: Error) => void
  /** @defaultValue 120000 */
  receiptTimeoutMs?: number
  /** Timeout for the approval + submission RPC calls (not the receipt wait — see `receiptTimeoutMs`). @defaultValue 30000 */
  rpcTimeoutMs?: number
}

export interface ExecuteInput {
  /** The spec's order_idempotency_key. Caller derives this from the triggering signal (e.g. the discovery event ID) so the same signal can never produce two orders. */
  idempotencyKey: string
  agentId: string
  token: Address
  quoteToken: Address
  side: 'buy' | 'sell'
  amountIn: bigint
  quote: SwapQuote
  slippageBps: number
}

/**
 * Signs, submits, and reconciles ONE order through the full lifecycle
 * (order-store.ts's state machine), backed by a real nonce reservation
 * (nonce-manager.ts) and real on-chain fill data (fill-reconciler.ts) — not
 * the pre-trade quote. "Quoteを約定と見なさない."
 *
 * Idempotency is structural: `execute()` for a key that already has a
 * non-CREATED row returns that row's CURRENT state immediately without
 * re-running any side effect (no second nonce reservation, no second
 * submission) — see the spec's "1 signalから2注文絶対禁止". A duplicate
 * signal arriving while the first is still in flight gets back the
 * in-progress row rather than a completed result; the caller re-checks
 * later (e.g. on the next tick) rather than this method blocking to await
 * a sibling call's completion.
 */
export class Executor {
  constructor(private readonly opts: ExecutorOptions) {}

  async execute(input: ExecuteInput): Promise<OrderRow> {
    const { created, row } = this.opts.orderStore.createOrder({
      idempotencyKey: input.idempotencyKey,
      agentId: input.agentId,
      token: input.token,
      side: input.side,
      quoteToken: input.quoteToken,
      amountIn: input.amountIn.toString(),
    })
    if (!created) return row // already known — idempotent no-op, whatever state it's currently in

    const key = input.idempotencyKey
    this.opts.orderStore.transition(key, 'CHECKED')
    this.opts.orderStore.transition(key, 'QUOTED', { quotedAmountOut: input.quote.amountOut })

    let nonce: number | null = null
    // Becomes true the instant sendTransaction is called — from then on, whether
    // that call actually reached the mempool before failing/timing out is
    // UNKNOWABLE from here (a hung RPC could have broadcast successfully and
    // simply not returned in time). Once true, the nonce is never released:
    // reusing it on a genuinely-broadcast-but-unconfirmed tx would submit a
    // second transaction racing the first for the same nonce — the exact
    // "nonce collision" the spec calls out. Recovery (recoverPendingOrders)
    // is the only safe path to resolve that ambiguity, against real chain state.
    let broadcastAttempted = false
    try {
      nonce = await this.opts.nonceManager.reserve()

      const tx = buildSwapTx(this.opts.client, input.quote, { slippageBps: input.slippageBps })
      const rpcTimeoutMs = this.opts.rpcTimeoutMs ?? 30_000
      await withTimeout(
        ensureApproval(
          this.opts.client,
          input.side === 'buy' ? input.quoteToken : input.token,
          input.amountIn,
        ),
        rpcTimeoutMs,
      )
      this.opts.orderStore.transition(key, 'SIGNED')

      broadcastAttempted = true
      const hash = await withTimeout(
        this.opts.client.wallet!.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          account: this.opts.account,
          chain: this.opts.client.chain,
          nonce,
        }),
        rpcTimeoutMs,
      )
      this.opts.orderStore.transition(key, 'SUBMITTED', { nonce, txHash: hash })

      const receipt = await withTimeout(
        this.opts.client.public.waitForTransactionReceipt({ hash }),
        this.opts.receiptTimeoutMs ?? 120_000,
      )
      return this.finalizeFromReceipt(key, input, receipt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!broadcastAttempted && nonce !== null) {
        await this.opts.nonceManager.release(nonce)
      }
      this.opts.orderStore.transition(key, 'FAILED', { error: message })
      this.opts.onError?.(err instanceof Error ? err : new Error(message))
      return this.opts.orderStore.get(key)!
    }
  }

  private finalizeFromReceipt(
    key: string,
    input: ExecuteInput,
    receipt: {
      status: 'success' | 'reverted'
      logs: readonly { address: Address; data: `0x${string}`; topics: readonly `0x${string}`[] }[]
    },
  ): OrderRow {
    if (receipt.status === 'reverted') {
      this.opts.orderStore.transition(key, 'FAILED', { error: 'transaction reverted on-chain' })
      return this.opts.orderStore.get(key)!
    }
    this.opts.orderStore.transition(key, 'MINED')
    this.opts.orderStore.transition(key, 'CONFIRMED')

    const outputToken = input.side === 'buy' ? input.token : input.quoteToken
    const fill = reconcileFill(
      receipt.logs as never,
      outputToken,
      this.opts.account.address,
      input.quote.amountOut,
      input.amountIn,
    )
    this.opts.orderStore.transition(key, 'RECONCILED', {
      actualAmountOut: fill.actualAmountOut,
      actualPrice: fill.actualPrice,
      actualSlippageBps: fill.actualSlippageBps,
    })
    return this.opts.orderStore.get(key)!
  }
}

/**
 * Restart recovery: every order left non-terminal by a prior crash is
 * reconciled against real chain state — never blindly resubmitted (a
 * resubmission risks a genuine double-spend if the original transaction
 * eventually confirms). An order stuck before SUBMITTED (never got a
 * txHash) is marked FAILED outright, since nothing was ever broadcast for
 * it. An order at SUBMITTED/MINED with a txHash is checked for a receipt;
 * found -> carried through to RECONCILED the normal way; not found (and not
 * within `graceMs` of its submission) -> left pending for the next recovery
 * pass rather than guessed at.
 */
export async function recoverPendingOrders(
  client: HoodClient,
  orderStore: OrderStore,
  executorForToken: (token: Address, quoteToken: Address) => { account: Address },
  graceMs = 5 * 60_000,
  now = Date.now(),
): Promise<{ recovered: number; failed: number; stillPending: number }> {
  let recovered = 0
  let failed = 0
  let stillPending = 0

  for (const order of orderStore.pending()) {
    if (!order.txHash) {
      orderStore.transition(order.idempotencyKey, 'FAILED', {
        error: 'restart recovery: never broadcast (no tx hash)',
      })
      failed++
      continue
    }
    try {
      const receipt = await client.public.getTransactionReceipt({ hash: order.txHash as `0x${string}` })
      if (receipt.status === 'reverted') {
        orderStore.transition(order.idempotencyKey, 'FAILED', {
          error: 'restart recovery: reverted on-chain',
        })
        failed++
        continue
      }
      if (order.state === 'SUBMITTED') orderStore.transition(order.idempotencyKey, 'MINED')
      orderStore.transition(order.idempotencyKey, 'CONFIRMED')
      const account = executorForToken(order.token, order.quoteToken).account
      const outputToken = order.side === 'buy' ? order.token : order.quoteToken
      const fill = reconcileFill(
        receipt.logs as never,
        outputToken,
        account,
        order.quotedAmountOut ?? 0n,
        order.amountIn,
      )
      orderStore.transition(order.idempotencyKey, 'RECONCILED', {
        actualAmountOut: fill.actualAmountOut,
        actualPrice: fill.actualPrice,
        actualSlippageBps: fill.actualSlippageBps,
      })
      recovered++
    } catch {
      // No receipt yet — still genuinely pending, unless it's been too long.
      if (order.submittedAt !== null && now - order.submittedAt > graceMs) {
        stillPending++ // left as-is deliberately — see doc comment; not auto-failed, not auto-resubmitted
      } else {
        stillPending++
      }
    }
  }
  return { recovered, failed, stillPending }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`receipt wait timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}
