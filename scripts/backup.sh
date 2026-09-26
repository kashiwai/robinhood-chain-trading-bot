#!/usr/bin/env bash
# Copies every SQLite store (journal, discovery, wallets, orders, probes) plus
# the shadow-run clock out to a timestamped directory, and records the run in
# <phase dir>/backup-status.json — the Level 10 Launch Gate reads that file's
# `lastRunAt` (from the specific phase it's checking) and refuses to allow
# live trading if it is missing or stale (see src/gates/launch-gate.ts
# BACKUP_PASS, src/main.ts).
#
# SQLite files are copied via `sqlite3 .backup` when the CLI is available
# (safe under WAL, even mid-write); falls back to a plain file copy of the
# .db/.db-wal/.db-shm triad otherwise, which is safe as long as no process is
# actively writing at that instant.
#
# Level 10.1: data is phase-scoped (data/shadow, data/paper, data/probe,
# data/live — see src/framework/config.ts's phaseScopedPath). Passing the
# DATA ROOT (default ./data) backs up EVERY phase subdirectory that exists,
# each getting its OWN backup-status.json (so each phase's Launch Gate
# reading sees a timestamp for ITS OWN data, not a sibling's). Passing a
# specific phase directory directly (e.g. ./data/live) backs up just that one.
#
# Usage: scripts/backup.sh [data root or phase dir, default ./data] [backup root, default <target>/backups]
set -euo pipefail

DATA_DIR="${1:-./data}"
BACKUP_ROOT_OVERRIDE="${2:-}"

backup_one_phase_dir() {
  local phase_dir="$1"
  local backup_root="${BACKUP_ROOT_OVERRIDE:-$phase_dir/backups}"
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local dest="$backup_root/$stamp"

  shopt -s nullglob
  local db_files=("$phase_dir"/*.db)
  if [ ${#db_files[@]} -eq 0 ]; then
    echo "backup: no *.db files found under $phase_dir — skipping (has this phase ever been started?)" >&2
    return 0
  fi

  mkdir -p "$dest"
  for db in "${db_files[@]}"; do
    local name
    name="$(basename "$db")"
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$db" ".backup '$dest/$name'"
    else
      cp "$db" "$dest/$name"
      [ -f "$db-wal" ] && cp "$db-wal" "$dest/$name-wal"
      [ -f "$db-shm" ] && cp "$db-shm" "$dest/$name-shm"
    fi
    echo "backed up $phase_dir/$name -> $dest/$name"
  done

  [ -f "$phase_dir/shadow-run.json" ] && cp "$phase_dir/shadow-run.json" "$dest/shadow-run.json"

  local now_ms
  now_ms=$(node -e "console.log(Date.now())")
  node -e "
const fs = require('node:fs');
fs.mkdirSync('$phase_dir', { recursive: true });
fs.writeFileSync('$phase_dir/backup-status.json', JSON.stringify({ lastRunAt: $now_ms }, null, 2));
"
  echo "backup complete: $dest"
  echo "wrote $phase_dir/backup-status.json (lastRunAt=$now_ms)"
}

FOUND_PHASE_SUBDIR=false
for phase in shadow paper probe live; do
  if [ -d "$DATA_DIR/$phase" ]; then
    FOUND_PHASE_SUBDIR=true
    backup_one_phase_dir "$DATA_DIR/$phase"
  fi
done

if [ "$FOUND_PHASE_SUBDIR" = false ]; then
  # DATA_DIR itself looks like a leaf phase directory (or a pre-10.1 flat layout).
  backup_one_phase_dir "$DATA_DIR"
fi
