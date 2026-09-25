# Backup & Recovery

## What gets backed up

`scripts/backup.sh` copies every SQLite store under the data directory
(`hood-traders.db` — the journal, `discovery.db`, `wallets.db`, `orders.db`, `probes.db`) plus
`shadow-run.json` — the persisted 72h uptime clock — into
`<data dir>/backups/<UTC timestamp>/`. It uses `sqlite3 .backup` (safe under WAL, even mid-write)
when the `sqlite3` CLI is available, falling back to a plain file copy of the `.db`/`.db-wal`/
`.db-shm` triad otherwise.

It also writes `<data dir>/backup-status.json` with `{ lastRunAt }` — this is the file
`src/main.ts`'s Launch Gate reads for the `BACKUP_PASS` flag (`src/gates/launch-gate.ts`), which
requires a backup within the last 24 hours before live trading is allowed to start.

```bash
scripts/backup.sh                # data dir defaults to ./data
scripts/backup.sh ./data ./somewhere-else   # explicit backup root
```

Run this on a cron/scheduled task in any real deployment — nothing in this codebase runs backups
automatically on a timer; `scripts/backup.sh` is the mechanism, scheduling it is an operator
responsibility (see `docs/OPERATIONS.md`).

## Restoring

```bash
scripts/restore.sh ./data/backups/20260101T000000Z
```

Destructive to the current data dir's `.db` files — requires typing `YES` at a prompt, no
`--force` flag exists. **Stop the fleet process first** — restoring into a live-mounted SQLite
file while a process still holds it open is unsupported.

Restoring also restores `shadow-run.json` if present in the backup — the 72h clock resumes from
the backed-up point, not from zero, so a restore doesn't accidentally reset shadow-run progress.

## Restart recovery (distinct from backup/restore)

`recoverPendingOrders()` (`src/execution/executor.ts`) runs automatically on every live-mode boot
— no script needed. It reconciles `OrderStore`'s non-terminal rows against real chain state:

- An order with a confirmed on-chain receipt → reconciled to its real terminal state.
- An order that never got a `txHash` → marked `FAILED` outright (nothing was ever broadcast).
- An order that's genuinely ambiguous (broadcast attempted, outcome unknown) → left pending for a
  human to check against a block explorer. **It never auto-resubmits** — a duplicate submission of
  an already-broadcast transaction risks a double spend, and no automatic reconciliation heuristic
  is worth that risk.

This is what `RECOVERY_PASS` in the Launch Gate refers to — a static fact about this codebase
(the call is unconditional on every live boot), not something re-verified at runtime.

## Disaster scenarios

| Scenario | Recovery path |
|---|---|
| Corrupted SQLite file | `scripts/restore.sh` from the most recent backup |
| Host lost entirely | Redeploy from git + `scripts/restore.sh` against a copied-off backup directory |
| Process crashed mid-trade | Restart — `recoverPendingOrders()` reconciles automatically, no manual step |
| Suspected compromised key | See `docs/INCIDENT_RESPONSE.md` — this is NOT a backup/restore scenario |
