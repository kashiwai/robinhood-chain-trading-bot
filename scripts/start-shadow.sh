#!/usr/bin/env bash
# Starts the 72-hour shadow run (spec 10-B): paper mode, real discovery, real
# wallet intelligence, real risk engine — no real money. Every 15s RPC health
# check feeds data/shadow/shadow-run.json's uptime clock
# (src/gates/shadow-run.ts), which the Launch Gate later requires >=72h at
# >=95% uptime.
#
# Level 10.1: runs under HOOD_RUN_PHASE=shadow, which scopes ALL of this
# process's SQLite stores under data/shadow/ — a separate DB, journal, and
# state cursor from start-paper.sh's data/paper/. The two can run
# simultaneously (see docs/LIVE_TRADING.md) without colliding, as long as
# DASHBOARD_PORT differs — this script defaults to 4671 (start-paper.sh
# defaults to 4672) so running both with zero extra config just works.
#
# The clock is NOT reset by restarting this script — only by deleting
# data/shadow/shadow-run.json yourself. If you want to start the 72h window
# over, delete that file first.
#
# Usage: scripts/start-shadow.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "hood-traders: starting SHADOW run (paper mode, real market data, no real funds)"
if [ -f ./data/shadow/shadow-run.json ]; then
  echo "data/shadow/shadow-run.json already exists — the 72h clock continues from where it left off (see src/gates/shadow-run.ts)."
else
  echo "no prior data/shadow/shadow-run.json found — the 72h clock starts now."
fi

export HOOD_TRADERS_LIVE=0
export HOOD_RUN_PHASE=shadow
export DASHBOARD_PORT="${DASHBOARD_PORT:-4671}"
exec npm run fleet
