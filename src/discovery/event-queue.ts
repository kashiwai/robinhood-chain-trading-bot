import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Lifecycle a discovery event moves through. `detected` = seen on-chain but
 * not yet confirmation-safe; `queued` = confirmation-safe and available to a
 * strategy; `processing` = a strategy has claimed it; `enriched` = safety/
 * liquidity checks ran; `decisioned` = a strategy returned an intent (buy or
 * explicit hold); `rejected` = filtered out (stale, no route, reorg, …);
 * `traded` = the Agent actually executed a fill for this event (wired by the
 * execution layer — see {@link EventQueue.markTraded}); `error` = an
 * unexpected exception while processing.
 */
export type QueueState =
  'detected' | 'queued' | 'processing' | 'enriched' | 'decisioned' | 'rejected' | 'traded' | 'error'

export interface QueueEventInput {
  chainId: number
  blockNumber: bigint
  transactionHash: string
  /**
   * Discriminates multiple events within the same (chainId, blockNumber,
   * transactionHash) — normally a log index. hoodchain's decoded `Launch`
   * event does not currently surface the raw log index, so callers pass the
   * most specific field they have (e.g. the launched token address — a
   * single transaction cannot launch the same token twice, so this is an
   * equally valid discriminator for that event kind).
   */
  discriminator: string
  kind: string
  payload: Record<string, unknown>
}

export interface QueueEventRow {
  eventId: string
  chainId: number
  blockNumber: bigint
  transactionHash: string
  discriminator: string
  kind: string
  state: QueueState
  payload: Record<string, unknown>
  detectedAt: number
  queuedAt: number | null
  processingAt: number | null
  enrichedAt: number | null
  decisionedAt: number | null
  orderSubmittedAt: number | null
  attempts: number
  error: string | null
}

/**
 * Durable, replay-safe event queue for on-chain discovery events. Every event
 * is persisted with a unique composite key BEFORE it is ever acted on, so the
 * same on-chain event delivered twice (duplicate push, watcher restart,
 * reconnect replay) is a no-op the second time rather than a duplicate order.
 *
 * Backed by SQLite (WAL mode) via better-sqlite3, matching {@link
 * ../framework/journal.js}'s persistence style. bigints are stored as decimal
 * TEXT for the same reason journal.ts does: SQLite's native integer is 64-bit
 * signed and block numbers/amounts can exceed that.
 */
export class EventQueue {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_events (
        event_id TEXT PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        block_number TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        discriminator TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        queued_at INTEGER,
        processing_at INTEGER,
        enriched_at INTEGER,
        decisioned_at INTEGER,
        order_submitted_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_discovery_state_kind ON discovery_events(state, kind, detected_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_composite
        ON discovery_events(chain_id, block_number, transaction_hash, discriminator);
    `)
  }

  static eventId(
    input: Pick<QueueEventInput, 'chainId' | 'blockNumber' | 'transactionHash' | 'discriminator'>,
  ): string {
    return `${input.chainId}:${input.blockNumber}:${input.transactionHash.toLowerCase()}:${input.discriminator.toLowerCase()}`
  }

  /**
   * Persist a newly detected event. Idempotent: a duplicate composite key
   * (same chain/block/tx/discriminator) is a no-op — returns `null` — rather
   * than a second row or a thrown error. This is the sole entry point onto
   * the queue; nothing downstream can be reached without landing here first.
   */
  recordDetected(input: QueueEventInput, now = Date.now()): string | null {
    const eventId = EventQueue.eventId(input)
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO discovery_events
           (event_id, chain_id, block_number, transaction_hash, discriminator, kind, state, payload, detected_at, attempts)
         VALUES (@event_id, @chain_id, @block_number, @transaction_hash, @discriminator, @kind, 'detected', @payload, @detected_at, 0)`,
      )
      .run({
        event_id: eventId,
        chain_id: input.chainId,
        block_number: input.blockNumber.toString(),
        transaction_hash: input.transactionHash,
        discriminator: input.discriminator,
        kind: input.kind,
        payload: JSON.stringify(input.payload),
        detected_at: now,
      })
    return info.changes > 0 ? eventId : null
  }

  /** Promote a confirmation-safe `detected` event to `queued`. */
  markQueued(eventId: string, now = Date.now()): void {
    this.transition(eventId, 'detected', 'queued', { queued_at: now })
  }

  /** A `detected` event whose transaction disappeared after the confirmation window — reorged out. */
  markReorged(eventId: string, detail: string, now = Date.now()): void {
    this.transition(eventId, 'detected', 'rejected', { error: detail })
    void now
  }

  /**
   * Atomically claim the oldest `queued` event of `kind` for processing.
   * Concurrency-safe under SQLite's single-writer model: the UPDATE only
   * matches rows still in `queued`, so two callers racing on the same row can
   * never both succeed.
   */
  claimNext(kind: string, now = Date.now()): QueueEventRow | null {
    const row = this.db
      .prepare(
        `SELECT event_id FROM discovery_events WHERE kind=? AND state='queued' ORDER BY detected_at ASC LIMIT 1`,
      )
      .get(kind) as { event_id: string } | undefined
    if (!row) return null
    const info = this.db
      .prepare(
        `UPDATE discovery_events SET state='processing', processing_at=?, attempts=attempts+1 WHERE event_id=? AND state='queued'`,
      )
      .run(now, row.event_id)
    if (info.changes === 0) return null // lost the race to another claimer
    return this.get(row.event_id)
  }

  markEnriched(eventId: string, now = Date.now()): void {
    this.transition(eventId, 'processing', 'enriched', { enriched_at: now })
  }

  markDecisioned(eventId: string, now = Date.now()): void {
    this.transitionFromAny(eventId, ['processing', 'enriched'], 'decisioned', { decisioned_at: now })
  }

  markRejected(eventId: string, reason: string): void {
    this.transitionFromAny(eventId, ['processing', 'enriched'], 'rejected', { error: reason })
  }

  markError(eventId: string, message: string): void {
    this.transitionFromAny(eventId, ['processing', 'enriched'], 'error', { error: message })
  }

  /**
   * Record that the execution layer actually submitted/filled an order for
   * this event. Not called anywhere yet in Level 2 — the Strategy interface
   * has no fill-outcome callback from the Agent today (see Level 6/9). Wired
   * in once the execution layer can report back.
   */
  markTraded(eventId: string, now = Date.now()): void {
    this.transitionFromAny(eventId, ['decisioned'], 'traded', { order_submitted_at: now })
  }

  get(eventId: string): QueueEventRow | null {
    const row = this.db.prepare(`SELECT * FROM discovery_events WHERE event_id=?`).get(eventId) as
      Record<string, unknown> | undefined
    return row ? toRow(row) : null
  }

  /** All events currently sitting in `detected` — the reorg guard's scan set. */
  detected(kind?: string): QueueEventRow[] {
    const rows = kind
      ? (this.db
          .prepare(`SELECT * FROM discovery_events WHERE state='detected' AND kind=?`)
          .all(kind) as Record<string, unknown>[])
      : (this.db.prepare(`SELECT * FROM discovery_events WHERE state='detected'`).all() as Record<
          string,
          unknown
        >[])
    return rows.map(toRow)
  }

  /** Snapshot counts per state — the KPI/replay-audit view. */
  stateCounts(kind?: string): Record<QueueState, number> {
    const rows = (
      kind
        ? this.db
            .prepare(`SELECT state, COUNT(*) n FROM discovery_events WHERE kind=? GROUP BY state`)
            .all(kind)
        : this.db.prepare(`SELECT state, COUNT(*) n FROM discovery_events GROUP BY state`).all()
    ) as { state: QueueState; n: number }[]
    const counts: Record<QueueState, number> = {
      detected: 0,
      queued: 0,
      processing: 0,
      enriched: 0,
      decisioned: 0,
      rejected: 0,
      traded: 0,
      error: 0,
    }
    for (const r of rows) counts[r.state] = r.n
    return counts
  }

  close(): void {
    this.db.close()
  }

  private transition(
    eventId: string,
    fromState: QueueState,
    toState: QueueState,
    extra: Record<string, string | number | null> = {},
  ): void {
    this.transitionFromAny(eventId, [fromState], toState, extra)
  }

  private transitionFromAny(
    eventId: string,
    fromStates: QueueState[],
    toState: QueueState,
    extra: Record<string, string | number | null> = {},
  ): void {
    const cols = Object.keys(extra)
    const setClause = ['state=@to_state', ...cols.map((c) => `${c}=@${c}`)].join(', ')
    const placeholders = fromStates.map((_, i) => `@from_${i}`).join(', ')
    const stmt = this.db.prepare(
      `UPDATE discovery_events SET ${setClause} WHERE event_id=@event_id AND state IN (${placeholders})`,
    )
    const params: Record<string, string | number | null> = { event_id: eventId, to_state: toState, ...extra }
    fromStates.forEach((s, i) => {
      params[`from_${i}`] = s
    })
    stmt.run(params)
  }
}

function toRow(r: Record<string, unknown>): QueueEventRow {
  return {
    eventId: r.event_id as string,
    chainId: r.chain_id as number,
    blockNumber: BigInt(r.block_number as string),
    transactionHash: r.transaction_hash as string,
    discriminator: r.discriminator as string,
    kind: r.kind as string,
    state: r.state as QueueState,
    payload: JSON.parse((r.payload as string) || '{}'),
    detectedAt: r.detected_at as number,
    queuedAt: (r.queued_at as number | null) ?? null,
    processingAt: (r.processing_at as number | null) ?? null,
    enrichedAt: (r.enriched_at as number | null) ?? null,
    decisionedAt: (r.decisioned_at as number | null) ?? null,
    orderSubmittedAt: (r.order_submitted_at as number | null) ?? null,
    attempts: r.attempts as number,
    error: (r.error as string | null) ?? null,
  }
}
