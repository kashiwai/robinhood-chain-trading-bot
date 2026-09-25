import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address } from 'viem'

export interface ClassifiedTradeInput {
  token: Address
  wallet: Address
  side: 'buy' | 'sell'
  /** Token units moved (smallest unit), as decimal string (bigint precision). */
  amountTokenWei: string
  /** USD value of this fill, priced at observation time (see wallet-tracker.ts's doc comment on pricing). */
  amountUsd: number
  /** USD market cap of the token at the moment of this fill (priceUsd * totalSupply), when computable. */
  mcapUsd: number | null
  blockNumber: bigint
  transactionHash: string
  logIndex: number
  ts: number
  /** Seconds between the token's first-seen launch and this fill — null if the token wasn't discovered via our own launch feed. */
  secondsSinceLaunch: number | null
}

export interface WalletStatsRow {
  wallet: Address
  firstSeen: number
  totalTrades: number
  winningTrades: number
  losingTrades: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number
  winRate: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  maxDrawdownUsd: number
  rugExposure: number
  medianEntryMcapUsd: number | null
  avgHoldMinutes: number | null
  earlyEntryScore: number | null
  lastUpdated: number
}

/**
 * Durable store for wallet intelligence: a raw classified-transfer ledger
 * (idempotent on `(token, transaction_hash, log_index)` — real, viem-decoded
 * log identity, unlike Level 2's launch events which had no log index to key
 * on), FIFO open-lot cost basis per (wallet, token) for realized-PnL and
 * hold-time accounting, and the aggregated `wallet_stats` row the spec calls
 * for.
 *
 * `recordTrade` does the ledger insert + FIFO matching + stats upsert inside
 * ONE better-sqlite3 transaction and returns whether it actually applied
 * (false = already-seen log, a no-op). The caller (wallet-tracker.ts) MUST
 * only advance its cursor after this returns — see that file's doc comment
 * for the full RPC-read → decode → DB-transaction → commit → cursor-update
 * ordering this exists to enforce.
 */
export class WalletStore {
  private readonly db: Database.Database
  private readonly recordTradeTxn: (input: ClassifiedTradeInput) => boolean

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
    this.recordTradeTxn = this.db.transaction((input: ClassifiedTradeInput) => this.applyTrade(input))
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        wallet TEXT NOT NULL,
        side TEXT NOT NULL,
        amount_token_wei TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        mcap_usd REAL,
        block_number TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        seconds_since_launch REAL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transfers_log
        ON wallet_transfers(token, transaction_hash, log_index);
      CREATE INDEX IF NOT EXISTS idx_wallet_transfers_wallet ON wallet_transfers(wallet, ts);

      CREATE TABLE IF NOT EXISTS open_lots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        token TEXT NOT NULL,
        amount_token_wei TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_open_lots_wallet_token ON open_lots(wallet, token, ts);

      CREATE TABLE IF NOT EXISTS wallet_stats (
        wallet TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        total_trades INTEGER NOT NULL DEFAULT 0,
        winning_trades INTEGER NOT NULL DEFAULT 0,
        losing_trades INTEGER NOT NULL DEFAULT 0,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        unrealized_pnl_usd REAL NOT NULL DEFAULT 0,
        gross_win_usd REAL NOT NULL DEFAULT 0,
        gross_loss_usd REAL NOT NULL DEFAULT 0,
        equity_peak_usd REAL NOT NULL DEFAULT 0,
        max_drawdown_usd REAL NOT NULL DEFAULT 0,
        rug_exposure REAL NOT NULL DEFAULT 0,
        hold_minutes_sum REAL NOT NULL DEFAULT 0,
        hold_minutes_count INTEGER NOT NULL DEFAULT 0,
        early_entry_score_sum REAL NOT NULL DEFAULT 0,
        early_entry_score_count INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cursors (
        token TEXT PRIMARY KEY,
        last_block TEXT NOT NULL
      );
    `)
  }

  cursorFor(token: Address): bigint | null {
    const row = this.db.prepare(`SELECT last_block FROM cursors WHERE token=?`).get(token.toLowerCase()) as
      { last_block: string } | undefined
    return row ? BigInt(row.last_block) : null
  }

  /** Advance the per-token backfill cursor. Call ONLY after the corresponding trade(s) have committed. */
  advanceCursor(token: Address, block: bigint): void {
    // last_block is stored as TEXT (bigint precision — see the class doc comment on why amounts/
    // block numbers use TEXT elsewhere in this repo); CAST to INTEGER for the comparison so this
    // is a numeric "only move forward" check, not a lexicographic string one ('50' > '100' as text).
    // Block numbers are nowhere near SQLite's 64-bit INTEGER ceiling, so the cast is lossless.
    this.db
      .prepare(
        `INSERT INTO cursors (token, last_block) VALUES (?, ?)
         ON CONFLICT(token) DO UPDATE SET last_block=excluded.last_block
         WHERE CAST(excluded.last_block AS INTEGER) > CAST(cursors.last_block AS INTEGER)`,
      )
      .run(token.toLowerCase(), block.toString())
  }

  /** Returns `true` if this fill was newly recorded, `false` if it was already in the ledger (idempotent replay). */
  recordTrade(input: ClassifiedTradeInput): boolean {
    return this.recordTradeTxn(input)
  }

  private applyTrade(input: ClassifiedTradeInput): boolean {
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO wallet_transfers
           (token, wallet, side, amount_token_wei, amount_usd, mcap_usd, block_number, transaction_hash, log_index, ts, seconds_since_launch)
         VALUES (@token,@wallet,@side,@amount_token_wei,@amount_usd,@mcap_usd,@block_number,@transaction_hash,@log_index,@ts,@seconds_since_launch)`,
      )
      .run({
        token: input.token.toLowerCase(),
        wallet: input.wallet.toLowerCase(),
        side: input.side,
        amount_token_wei: input.amountTokenWei,
        amount_usd: input.amountUsd,
        mcap_usd: input.mcapUsd,
        block_number: input.blockNumber.toString(),
        transaction_hash: input.transactionHash,
        log_index: input.logIndex,
        ts: input.ts,
        seconds_since_launch: input.secondsSinceLaunch,
      })
    if (inserted.changes === 0) return false // already-seen log — idempotent no-op

    this.ensureStatsRow(input.wallet, input.ts)
    if (input.side === 'buy') {
      this.applyBuy(input)
    } else {
      this.applySell(input)
    }
    return true
  }

  private ensureStatsRow(wallet: Address, now: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO wallet_stats (wallet, first_seen, last_updated) VALUES (?, ?, ?)`)
      .run(wallet.toLowerCase(), now, now)
  }

  private applyBuy(input: ClassifiedTradeInput): void {
    this.db
      .prepare(`INSERT INTO open_lots (wallet, token, amount_token_wei, cost_usd, ts) VALUES (?,?,?,?,?)`)
      .run(
        input.wallet.toLowerCase(),
        input.token.toLowerCase(),
        input.amountTokenWei,
        input.amountUsd,
        input.ts,
      )

    this.db
      .prepare(
        `UPDATE wallet_stats SET
           total_trades = total_trades + 1,
           early_entry_score_sum = early_entry_score_sum + @early,
           early_entry_score_count = early_entry_score_count + @early_count,
           last_updated = @ts
         WHERE wallet = @wallet`,
      )
      .run({
        wallet: input.wallet.toLowerCase(),
        ts: input.ts,
        early: input.secondsSinceLaunch === null ? 0 : earlyEntryScore(input.secondsSinceLaunch),
        early_count: input.secondsSinceLaunch === null ? 0 : 1,
      })
  }

  /** FIFO-match this sell against the wallet's open lots for the token, realizing PnL and hold time per lot consumed. */
  private applySell(input: ClassifiedTradeInput): void {
    const walletLower = input.wallet.toLowerCase()
    const tokenLower = input.token.toLowerCase()
    let remaining = BigInt(input.amountTokenWei)
    const sellValueUsd = input.amountUsd
    const totalSoldWei = remaining
    let realizedPnlUsd = 0
    let holdMinutesWeighted = 0

    const lots = this.db
      .prepare(`SELECT * FROM open_lots WHERE wallet=? AND token=? ORDER BY ts ASC`)
      .all(walletLower, tokenLower) as {
      id: number
      amount_token_wei: string
      cost_usd: number
      ts: number
    }[]

    for (const lot of lots) {
      if (remaining <= 0n) break
      const lotAmount = BigInt(lot.amount_token_wei)
      const consume = lotAmount < remaining ? lotAmount : remaining
      const fraction = lotAmount > 0n ? Number(consume) / Number(lotAmount) : 0
      const costOfConsumed = lot.cost_usd * fraction
      const saleFraction = totalSoldWei > 0n ? Number(consume) / Number(totalSoldWei) : 0
      const proceedsOfConsumed = sellValueUsd * saleFraction
      realizedPnlUsd += proceedsOfConsumed - costOfConsumed
      holdMinutesWeighted += ((input.ts - lot.ts) / 60_000) * Number(consume)

      const left = lotAmount - consume
      if (left <= 0n) {
        this.db.prepare(`DELETE FROM open_lots WHERE id=?`).run(lot.id)
      } else {
        const leftCost = lot.cost_usd * (1 - fraction)
        this.db
          .prepare(`UPDATE open_lots SET amount_token_wei=?, cost_usd=? WHERE id=?`)
          .run(left.toString(), leftCost, lot.id)
      }
      remaining -= consume
    }

    const avgHoldMinutes = totalSoldWei > 0n ? holdMinutesWeighted / Number(totalSoldWei) : 0
    const isWin = realizedPnlUsd > 0

    const row = this.db.prepare(`SELECT * FROM wallet_stats WHERE wallet=?`).get(walletLower) as {
      gross_win_usd: number
      gross_loss_usd: number
      realized_pnl_usd: number
      equity_peak_usd: number
      max_drawdown_usd: number
    }
    const newRealized = row.realized_pnl_usd + realizedPnlUsd
    const newGrossWin = row.gross_win_usd + (isWin ? realizedPnlUsd : 0)
    const newGrossLoss = row.gross_loss_usd + (isWin ? 0 : -realizedPnlUsd)
    const newPeak = Math.max(row.equity_peak_usd, newRealized)
    const drawdown = newPeak - newRealized
    const newMaxDrawdown = Math.max(row.max_drawdown_usd, drawdown)

    this.db
      .prepare(
        `UPDATE wallet_stats SET
           total_trades = total_trades + 1,
           winning_trades = winning_trades + @win,
           losing_trades = losing_trades + @loss,
           realized_pnl_usd = @realized,
           gross_win_usd = @gross_win,
           gross_loss_usd = @gross_loss,
           equity_peak_usd = @peak,
           max_drawdown_usd = @drawdown,
           hold_minutes_sum = hold_minutes_sum + @hold_minutes,
           hold_minutes_count = hold_minutes_count + 1,
           last_updated = @ts
         WHERE wallet = @wallet`,
      )
      .run({
        wallet: walletLower,
        ts: input.ts,
        win: isWin ? 1 : 0,
        loss: isWin ? 0 : 1,
        realized: newRealized,
        gross_win: newGrossWin,
        gross_loss: newGrossLoss,
        peak: newPeak,
        drawdown: newMaxDrawdown,
        hold_minutes: avgHoldMinutes,
      })
  }

  get(wallet: Address): WalletStatsRow | null {
    const row = this.db.prepare(`SELECT * FROM wallet_stats WHERE wallet=?`).get(wallet.toLowerCase()) as
      Record<string, unknown> | undefined
    if (!row) return null
    return toStatsRow(row, this.medianEntryMcap(wallet))
  }

  private medianEntryMcap(wallet: Address): number | null {
    const rows = this.db
      .prepare(
        `SELECT mcap_usd FROM wallet_transfers WHERE wallet=? AND side='buy' AND mcap_usd IS NOT NULL ORDER BY mcap_usd ASC`,
      )
      .all(wallet.toLowerCase()) as { mcap_usd: number }[]
    if (rows.length === 0) return null
    const mid = Math.floor(rows.length / 2)
    return rows.length % 2 === 0 ? (rows[mid - 1]!.mcap_usd + rows[mid]!.mcap_usd) / 2 : rows[mid]!.mcap_usd
  }

  /** Open lots for a wallet — used to mark unrealized PnL against a live spot price. */
  openPositions(wallet: Address, token: Address): { amountTokenWei: bigint; costUsd: number }[] {
    const rows = this.db
      .prepare(`SELECT amount_token_wei, cost_usd FROM open_lots WHERE wallet=? AND token=?`)
      .all(wallet.toLowerCase(), token.toLowerCase()) as { amount_token_wei: string; cost_usd: number }[]
    return rows.map((r) => ({ amountTokenWei: BigInt(r.amount_token_wei), costUsd: r.cost_usd }))
  }

  setUnrealizedPnl(wallet: Address, unrealizedPnlUsd: number, now = Date.now()): void {
    this.ensureStatsRow(wallet, now)
    this.db
      .prepare(`UPDATE wallet_stats SET unrealized_pnl_usd=?, last_updated=? WHERE wallet=?`)
      .run(unrealizedPnlUsd, now, wallet.toLowerCase())
  }

  /**
   * Every classified buy/sell for `token` since `sinceMs` — the raw material
   * for Level 8's buy_pressure/sell_pressure/volume_acceleration/
   * price_momentum feature-vector fields (see decision/feature-vector.ts).
   */
  recentTransfers(
    token: Address,
    sinceMs: number,
  ): { side: 'buy' | 'sell'; wallet: Address; amountUsd: number; mcapUsd: number | null; ts: number }[] {
    const rows = this.db
      .prepare(
        `SELECT side, wallet, amount_usd, mcap_usd, ts FROM wallet_transfers WHERE token=? AND ts>=? ORDER BY ts ASC`,
      )
      .all(token.toLowerCase(), sinceMs) as {
      side: 'buy' | 'sell'
      wallet: string
      amount_usd: number
      mcap_usd: number | null
      ts: number
    }[]
    return rows.map((r) => ({
      side: r.side,
      wallet: r.wallet as Address,
      amountUsd: r.amount_usd,
      mcapUsd: r.mcap_usd,
      ts: r.ts,
    }))
  }

  /** Distinct wallets that bought `token` since `sinceMs` — used to pull smart-wallet scores for the feature vector. */
  recentBuyers(token: Address, sinceMs: number): Address[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT wallet FROM wallet_transfers WHERE token=? AND side='buy' AND ts>=?`)
      .all(token.toLowerCase(), sinceMs) as { wallet: string }[]
    return rows.map((r) => r.wallet as Address)
  }

  close(): void {
    this.db.close()
  }
}

/** Linear decay from 1.0 (at t=0) to 0.0 (at EARLY_WINDOW_SECONDS or beyond). A simple, documented initial heuristic — see wallet-score.ts. */
export const EARLY_WINDOW_SECONDS = 10 * 60
function earlyEntryScore(secondsSinceLaunch: number): number {
  return Math.max(0, 1 - secondsSinceLaunch / EARLY_WINDOW_SECONDS)
}

function toStatsRow(r: Record<string, unknown>, medianEntryMcapUsd: number | null): WalletStatsRow {
  const totalTrades = r.total_trades as number
  const winningTrades = r.winning_trades as number
  const losingTrades = r.losing_trades as number
  const grossWin = r.gross_win_usd as number
  const grossLoss = r.gross_loss_usd as number
  const holdCount = r.hold_minutes_count as number
  const earlyCount = r.early_entry_score_count as number
  return {
    wallet: r.wallet as Address,
    firstSeen: r.first_seen as number,
    totalTrades,
    winningTrades,
    losingTrades,
    realizedPnlUsd: r.realized_pnl_usd as number,
    unrealizedPnlUsd: r.unrealized_pnl_usd as number,
    winRate: winningTrades + losingTrades > 0 ? winningTrades / (winningTrades + losingTrades) : 0,
    avgWin: winningTrades > 0 ? grossWin / winningTrades : 0,
    avgLoss: losingTrades > 0 ? grossLoss / losingTrades : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownUsd: r.max_drawdown_usd as number,
    rugExposure: r.rug_exposure as number, // always 0 until Level 5's risk scanner feeds this — see wallet-tracker.ts
    medianEntryMcapUsd,
    avgHoldMinutes: holdCount > 0 ? (r.hold_minutes_sum as number) / holdCount : null,
    earlyEntryScore: earlyCount > 0 ? (r.early_entry_score_sum as number) / earlyCount : null,
    lastUpdated: r.last_updated as number,
  }
}
