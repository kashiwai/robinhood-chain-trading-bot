import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address } from 'viem'

export type OrderState =
  | 'CREATED'
  | 'CHECKED'
  | 'QUOTED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'MINED'
  | 'CONFIRMED'
  | 'RECONCILED'
  | 'FAILED'
  | 'CANCELLED'

export interface OrderInput {
  /** The spec's `order_idempotency_key` — one signal maps to exactly one order, forever. Caller-supplied (see executor.ts). */
  idempotencyKey: string
  agentId: string
  token: Address
  side: 'buy' | 'sell'
  quoteToken: Address
  amountIn: string // decimal bigint string
}

export interface OrderRow {
  idempotencyKey: string
  agentId: string
  token: Address
  side: 'buy' | 'sell'
  quoteToken: Address
  amountIn: bigint
  state: OrderState
  nonce: number | null
  txHash: string | null
  quotedAmountOut: bigint | null
  actualAmountOut: bigint | null
  actualPrice: number | null
  actualSlippageBps: number | null
  error: string | null
  attempts: number
  createdAt: number
  submittedAt: number | null
  minedAt: number | null
  confirmedAt: number | null
  reconciledAt: number | null
}

const TERMINAL: ReadonlySet<OrderState> = new Set(['RECONCILED', 'FAILED', 'CANCELLED'])

/**
 * Durable order lifecycle: CREATED -> CHECKED -> QUOTED -> SIGNED ->
 * SUBMITTED -> MINED -> CONFIRMED -> RECONCILED, with FAILED/CANCELLED
 * reachable from any non-terminal state. `idempotencyKey` is the primary
 * key, so `createOrder` for a key that already exists is a no-op — the
 * spec's "1 signalから2注文絶対禁止" enforced structurally, not by
 * discipline: nothing downstream (nonce reservation, signing, submission)
 * can happen without first landing a row here, and a second attempt for the
 * same key returns the EXISTING row instead of creating another one.
 */
export class OrderStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        idempotency_key TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        token TEXT NOT NULL,
        side TEXT NOT NULL,
        quote_token TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        state TEXT NOT NULL,
        nonce INTEGER,
        tx_hash TEXT,
        quoted_amount_out TEXT,
        actual_amount_out TEXT,
        actual_price REAL,
        actual_slippage_bps REAL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        submitted_at INTEGER,
        mined_at INTEGER,
        confirmed_at INTEGER,
        reconciled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
      CREATE INDEX IF NOT EXISTS idx_orders_tx_hash ON orders(tx_hash);
    `)
  }

  /** Idempotent: returns `{created:false, row}` for an already-known key instead of inserting again. */
  createOrder(input: OrderInput, now = Date.now()): { created: boolean; row: OrderRow } {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO orders (idempotency_key, agent_id, token, side, quote_token, amount_in, state, attempts, created_at)
         VALUES (@key, @agent_id, @token, @side, @quote_token, @amount_in, 'CREATED', 0, @now)`,
      )
      .run({
        key: input.idempotencyKey,
        agent_id: input.agentId,
        token: input.token.toLowerCase(),
        side: input.side,
        quote_token: input.quoteToken.toLowerCase(),
        amount_in: input.amountIn,
        now,
      })
    return { created: info.changes > 0, row: this.get(input.idempotencyKey)! }
  }

  get(idempotencyKey: string): OrderRow | null {
    const row = this.db.prepare(`SELECT * FROM orders WHERE idempotency_key=?`).get(idempotencyKey) as
      Record<string, unknown> | undefined
    return row ? toRow(row) : null
  }

  /** Every order still short of a terminal state — the restart-recovery scan set (see nonce-manager.ts / executor.ts). */
  pending(): OrderRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE state NOT IN ('RECONCILED','FAILED','CANCELLED')`)
      .all() as Record<string, unknown>[]
    return rows.map(toRow)
  }

  transition(key: string, to: OrderState, extra: Partial<OrderRow> = {}, now = Date.now()): void {
    const current = this.get(key)
    if (!current) throw new Error(`order-store: no such order ${key}`)
    if (TERMINAL.has(current.state)) return // terminal states never transition further — a stray late event is a no-op

    const sets: string[] = ['state=@state']
    const params: Record<string, unknown> = { key, state: to }
    if (extra.nonce !== undefined) {
      sets.push('nonce=@nonce')
      params.nonce = extra.nonce
    }
    if (extra.txHash !== undefined) {
      sets.push('tx_hash=@tx_hash')
      params.tx_hash = extra.txHash
    }
    if (extra.quotedAmountOut !== undefined) {
      sets.push('quoted_amount_out=@quoted_amount_out')
      params.quoted_amount_out = extra.quotedAmountOut?.toString() ?? null
    }
    if (extra.actualAmountOut !== undefined) {
      sets.push('actual_amount_out=@actual_amount_out')
      params.actual_amount_out = extra.actualAmountOut?.toString() ?? null
    }
    if (extra.actualPrice !== undefined) {
      sets.push('actual_price=@actual_price')
      params.actual_price = extra.actualPrice
    }
    if (extra.actualSlippageBps !== undefined) {
      sets.push('actual_slippage_bps=@actual_slippage_bps')
      params.actual_slippage_bps = extra.actualSlippageBps
    }
    if (extra.error !== undefined) {
      sets.push('error=@error')
      params.error = extra.error
    }
    if (to === 'SUBMITTED') {
      sets.push('submitted_at=@ts', 'attempts=attempts+1')
      params.ts = now
    } else if (to === 'MINED') {
      sets.push('mined_at=@ts')
      params.ts = now
    } else if (to === 'CONFIRMED') {
      sets.push('confirmed_at=@ts')
      params.ts = now
    } else if (to === 'RECONCILED') {
      sets.push('reconciled_at=@ts')
      params.ts = now
    }

    this.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE idempotency_key=@key`).run(params)
  }

  close(): void {
    this.db.close()
  }
}

function toRow(r: Record<string, unknown>): OrderRow {
  return {
    idempotencyKey: r.idempotency_key as string,
    agentId: r.agent_id as string,
    token: r.token as Address,
    side: r.side as 'buy' | 'sell',
    quoteToken: r.quote_token as Address,
    amountIn: BigInt(r.amount_in as string),
    state: r.state as OrderState,
    nonce: (r.nonce as number | null) ?? null,
    txHash: (r.tx_hash as string | null) ?? null,
    quotedAmountOut: r.quoted_amount_out ? BigInt(r.quoted_amount_out as string) : null,
    actualAmountOut: r.actual_amount_out ? BigInt(r.actual_amount_out as string) : null,
    actualPrice: (r.actual_price as number | null) ?? null,
    actualSlippageBps: (r.actual_slippage_bps as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    attempts: r.attempts as number,
    createdAt: r.created_at as number,
    submittedAt: (r.submitted_at as number | null) ?? null,
    minedAt: (r.mined_at as number | null) ?? null,
    confirmedAt: (r.confirmed_at as number | null) ?? null,
    reconciledAt: (r.reconciled_at as number | null) ?? null,
  }
}
