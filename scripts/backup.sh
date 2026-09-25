#!/usr/bin/env bash
# Copies every SQLite store (journal, discovery, wallets, orders, probes) plus
# the shadow-run clock out to a timestamped directory, and records the run in
# data/backup-status.json — the Level 10 Launch Gate reads that file's
# `lastRunAt` and refuses to allow live trading if it is missing or stale
# (see src/gates/launch-gate.ts BACKUP_PASS, src/main.ts).
#
# SQLite files are copied via `sqlite3 .backup` when the CLI is available
# (safe under WAL, even mid-write); falls back to a plain file copy of the
# .db/.db-wal/.db-shm triad otherwise, which is safe as long as no process is
# actively writing at that instant.
#
# Backups default to a subdirectory OF the data dir (not a sibling) so a
# single mounted volume (see docker-compose.yml) captures both live data and
# its own backups without a second mount.
#
# Usage: scripts/backup.sh [data dir, default ./data] [backup root, default <data dir>/backups]
set -euo pipefail

DATA_DIR="${1:-./data}"
BACKUP_ROOT="${2:-$DATA_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST"

shopt -s nullglob
DB_FILES=("$DATA_DIR"/*.db)
if [ ${#DB_FILES[@]} -eq 0 ]; then
  echo "backup: no *.db files found under $DATA_DIR — nothing to back up yet (has the fleet been started?)" >&2
  exit 1
fi

for db in "${DB_FILES[@]}"; do
  name="$(basename "$db")"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" ".backup '$DEST/$name'"
  else
    cp "$db" "$DEST/$name"
    [ -f "$db-wal" ] && cp "$db-wal" "$DEST/$name-wal"
    [ -f "$db-shm" ] && cp "$db-shm" "$DEST/$name-shm"
  fi
  echo "backed up $name -> $DEST/$name"
done

[ -f "$DATA_DIR/shadow-run.json" ] && cp "$DATA_DIR/shadow-run.json" "$DEST/shadow-run.json"

NOW_MS=$(node -e "console.log(Date.now())")
node -e "
const fs = require('node:fs');
fs.mkdirSync('$DATA_DIR', { recursive: true });
fs.writeFileSync('$DATA_DIR/backup-status.json', JSON.stringify({ lastRunAt: $NOW_MS }, null, 2));
"

echo "backup complete: $DEST"
echo "wrote $DATA_DIR/backup-status.json (lastRunAt=$NOW_MS)"
