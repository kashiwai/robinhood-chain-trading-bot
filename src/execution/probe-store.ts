import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address } from 'viem'

export interface ProbeRecord {
  token: Address
  passed: boolean
  reason: string
  measuredBuyTaxBps: number | null
  measuredSellTaxBps: number | null
  ts: number
}

/**
 * Probe outcomes and the resulting blacklist. A failed probe blacklists the
 * token permanently for this process's lifetime (and across restarts, since
 * this is durable) — "新規本注文禁止", the spec's own words. Blacklisting is
 * one-way: nothing in this store un-blacklists a token. That's a deliberate
 * operator-only action (there's no `unblacklist` method) since a token that
 * failed a real $2 buy/sell round trip has demonstrated the exact failure
 * mode the probe exists to catch.
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
  }

  record(r: ProbeRecord): void {
    this.db
      .prepare(
        `INSERT INTO probes (token, passed, reason, measured_buy_tax_bps, measured_sell_tax_bps, ts)
         VALUES (@token,@passed,@reason,@buy_tax,@sell_tax,@ts)
         ON CONFLICT(token) DO UPDATE SET passed=@passed, reason=@reason,
           measured_buy_tax_bps=@buy_tax, measured_sell_tax_bps=@sell_tax, ts=@ts`,
      )
      .run({
        token: r.token.toLowerCase(),
        passed: r.passed ? 1 : 0,
        reason: r.reason,
        buy_tax: r.measuredBuyTaxBps,
        sell_tax: r.measuredSellTaxBps,
        ts: r.ts,
      })
  }

  isBlacklisted(token: Address): boolean {
    const row = this.db.prepare(`SELECT passed FROM probes WHERE token=?`).get(token.toLowerCase()) as
      { passed: number } | undefined
    return row !== undefined && row.passed === 0
  }

  hasPassed(token: Address): boolean {
    const row = this.db.prepare(`SELECT passed FROM probes WHERE token=?`).get(token.toLowerCase()) as
      { passed: number } | undefined
    return row !== undefined && row.passed === 1
  }

  get(token: Address): ProbeRecord | null {
    const row = this.db.prepare(`SELECT * FROM probes WHERE token=?`).get(token.toLowerCase()) as
      Record<string, unknown> | undefined
    if (!row) return null
    return {
      token: row.token as Address,
      passed: row.passed === 1,
      reason: row.reason as string,
      measuredBuyTaxBps: (row.measured_buy_tax_bps as number | null) ?? null,
      measuredSellTaxBps: (row.measured_sell_tax_bps as number | null) ?? null,
      ts: row.ts as number,
    }
  }

  close(): void {
    this.db.close()
  }
}
