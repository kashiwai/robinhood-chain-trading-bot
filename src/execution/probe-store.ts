import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address } from 'viem'
import type { ProbeFailureClass } from './probe-failure.js'

export interface ProbeRecord {
  token: Address
  passed: boolean
  reason: string
  measuredBuyTaxBps: number | null
  measuredSellTaxBps: number | null
  ts: number
  /** null when `passed` is true. See probe-failure.ts for the classification rules. */
  failureClass: ProbeFailureClass | null
  /** How many TEMPORARY_INFRA_FAILURE/MARKET_FAILURE attempts this token has accumulated — never incremented by a PERMANENT_TOKEN_FAILURE, since that one never gets a retry. */
  retryCount: number
}

export interface RecordInput {
  token: Address
  passed: boolean
  reason: string
  measuredBuyTaxBps: number | null
  measuredSellTaxBps: number | null
  ts: number
  failureClass?: ProbeFailureClass | null
}

/**
 * Probe outcomes and the resulting blacklist/quarantine state. Level 10.1
 * refines Level 7's original "any failure blacklists forever" into three
 * buckets (see probe-failure.ts): only `PERMANENT_TOKEN_FAILURE` blacklists
 * permanently ("新規本注文禁止" stays true to the spec's words for a REAL
 * token-side failure). `TEMPORARY_INFRA_FAILURE` and `MARKET_FAILURE`
 * quarantine the token for a configurable cooldown instead — an RPC timeout
 * or a thin order book at probe time says nothing about the token itself.
 * Blacklisting (the permanent case) is still one-way: nothing here
 * un-blacklists a token — that remains a deliberate, manual operator action.
 */
export class ProbeStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS probes (
        token TEXT PRIMARY KEY,
        passed INTEGER NOT NULL,
        reason TEXT NOT NULL,
        measured_buy_tax_bps REAL,
        measured_sell_tax_bps REAL,
        ts INTEGER NOT NULL
      );
    `)
    // Lightweight, idempotent migration for a table that may already exist
    // on disk from a pre-10.1 run — SQLite has no "ADD COLUMN IF NOT
    // EXISTS", so a duplicate-column error here just means it already ran.
    for (const ddl of [
      `ALTER TABLE probes ADD COLUMN failure_class TEXT`,
      `ALTER TABLE probes ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(ddl)
      } catch {
        // column already exists — fine
      }
    }
  }

  record(r: RecordInput): void {
    const previousRetryCount = this.get(r.token)?.retryCount ?? 0
    const failureClass = r.passed ? null : (r.failureClass ?? null)
    const retryCount = r.passed
      ? 0
      : failureClass === 'PERMANENT_TOKEN_FAILURE'
        ? previousRetryCount
        : previousRetryCount + 1
    this.db
      .prepare(
        `INSERT INTO probes (token, passed, reason, measured_buy_tax_bps, measured_sell_tax_bps, ts, failure_class, retry_count)
         VALUES (@token,@passed,@reason,@buy_tax,@sell_tax,@ts,@failure_class,@retry_count)
         ON CONFLICT(token) DO UPDATE SET passed=@passed, reason=@reason,
           measured_buy_tax_bps=@buy_tax, measured_sell_tax_bps=@sell_tax, ts=@ts,
           failure_class=@failure_class, retry_count=@retry_count`,
      )
      .run({
        token: r.token.toLowerCase(),
        passed: r.passed ? 1 : 0,
        reason: r.reason,
        buy_tax: r.measuredBuyTaxBps,
        sell_tax: r.measuredSellTaxBps,
        ts: r.ts,
        failure_class: failureClass,
        retry_count: retryCount,
      })
  }

  /** Permanently blacklisted — only ever true for a PERMANENT_TOKEN_FAILURE. */
  isBlacklisted(token: Address): boolean {
    const row = this.db
      .prepare(`SELECT passed, failure_class FROM probes WHERE token=?`)
      .get(token.toLowerCase()) as { passed: number; failure_class: string | null } | undefined
    return row !== undefined && row.passed === 0 && row.failure_class === 'PERMANENT_TOKEN_FAILURE'
  }

  /**
   * A TEMPORARY_INFRA_FAILURE/MARKET_FAILURE that hasn't cleared its cooldown
   * yet — not blacklisted, just not eligible for a retry attempt THIS
   * moment. `false` once `cooldownMs` has elapsed since the last attempt,
   * so the caller (see execution/probe-gate.ts) knows to try again.
   */
  isQuarantined(token: Address, now: number, cooldownMs: number): boolean {
    const row = this.get(token)
    if (!row || row.passed || row.failureClass === null || row.failureClass === 'PERMANENT_TOKEN_FAILURE') {
      return false
    }
    return now - row.ts < cooldownMs
  }

  hasPassed(token: Address): boolean {
    const row = this.db.prepare(`SELECT passed FROM probes WHERE token=?`).get(token.toLowerCase()) as
      { passed: number } | undefined
    return row !== undefined && row.passed === 1
  }

  get(token: Address): ProbeRecord | null {
    const row = this.db.prepare(`SELECT * FROM probes WHERE token=?`).get(token.toLowerCase()) as
      Record<string, unknown> | undefined
    return row ? toRecord(row) : null
  }

  /** Every probe ever recorded, oldest first — the Level 10 10-D evidence source (see gates/collect-evidence.ts). */
  allRecords(): ProbeRecord[] {
    const rows = this.db.prepare(`SELECT * FROM probes ORDER BY ts ASC`).all() as Record<string, unknown>[]
    return rows.map(toRecord)
  }

  close(): void {
    this.db.close()
  }
}

function toRecord(row: Record<string, unknown>): ProbeRecord {
  return {
    token: row.token as Address,
    passed: row.passed === 1,
    reason: row.reason as string,
    measuredBuyTaxBps: (row.measured_buy_tax_bps as number | null) ?? null,
    measuredSellTaxBps: (row.measured_sell_tax_bps as number | null) ?? null,
    ts: row.ts as number,
    failureClass: (row.failure_class as ProbeFailureClass | null) ?? null,
    retryCount: (row.retry_count as number | null) ?? 0,
  }
}
