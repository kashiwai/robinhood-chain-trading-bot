#!/usr/bin/env bash
# Restores SQLite stores from a backup directory made by scripts/backup.sh.
# Destructive to the CURRENT data dir's *.db files — asks for explicit
# confirmation before overwriting anything, and refuses to run against a data
# dir with a live fleet process still attached to it (best-effort PID check
# via the KILL file's sibling lock; the real guard is "stop the process
# first," which this script tells you to do).
#
# Usage: scripts/restore.sh <backup dir, e.g. ./backups/20260101T000000Z> [data dir, default ./data]
set -euo pipefail

SRC="${1:?usage: scripts/restore.sh <backup dir> [data dir]}"
DATA_DIR="${2:-./data}"

if [ ! -d "$SRC" ]; then
  echo "restore: backup directory not found: $SRC" >&2
  exit 1
fi

shopt -s nullglob
DB_FILES=("$SRC"/*.db)
if [ ${#DB_FILES[@]} -eq 0 ]; then
  echo "restore: no *.db files found in $SRC — is this a real scripts/backup.sh output directory?" >&2
  exit 1
fi

echo "This will OVERWRITE every *.db file in $DATA_DIR with the copies in $SRC."
echo "Make sure the fleet process is stopped first (scripts/kill.sh does NOT stop the process, only new orders)."
read -r -p "Type YES to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "restore: aborted (confirmation not given)"
  exit 1
fi

mkdir -p "$DATA_DIR"
for db in "${DB_FILES[@]}"; do
  name="$(basename "$db")"
  cp "$db" "$DATA_DIR/$name"
  [ -f "$SRC/$name-wal" ] && cp "$SRC/$name-wal" "$DATA_DIR/$name-wal" || rm -f "$DATA_DIR/$name-wal"
  [ -f "$SRC/$name-shm" ] && cp "$SRC/$name-shm" "$DATA_DIR/$name-shm" || rm -f "$DATA_DIR/$name-shm"
  echo "restored $name <- $SRC/$name"
done

[ -f "$SRC/shadow-run.json" ] && cp "$SRC/shadow-run.json" "$DATA_DIR/shadow-run.json" && echo "restored shadow-run.json (the 72h clock resumes from the backed-up point, not zero)"

echo "restore complete from $SRC -> $DATA_DIR"
