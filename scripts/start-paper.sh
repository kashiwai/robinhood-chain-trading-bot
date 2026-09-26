#!/usr/bin/env bash
# Starts the fleet in paper mode to accumulate closed paper trades (spec
# 10-C: >=200 closed paper trades before live).
#
# Level 10.1: this is now a GENUINELY SEPARATE process/data directory from
# start-shadow.sh — HOOD_RUN_PHASE=paper scopes every SQLite store under
# data/paper/, independent of data/shadow/'s DB, journal, and state cursor.
# The two can run at the same time (see docs/LIVE_TRADING.md); this script
# defaults to DASHBOARD_PORT=4672 so it doesn't collide with
# start-shadow.sh's default of 4671.
#
# Usage: scripts/start-paper.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "hood-traders: starting PAPER trading (simulated fills, no real funds)"
export HOOD_TRADERS_LIVE=0
export HOOD_RUN_PHASE=paper
export DASHBOARD_PORT="${DASHBOARD_PORT:-4672}"
exec npm run fleet
