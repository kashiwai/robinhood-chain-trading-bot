#!/usr/bin/env bash
# Starts the 72-hour shadow run (spec 10-B): paper mode, real discovery, real
# wallet intelligence, real risk engine — no real money. Every 15s RPC health
# check feeds data/shadow-run.json's uptime clock (src/gates/shadow-run.ts),
# which the Launch Gate later requires >=72h at >=95% uptime.
#
# The clock is NOT reset by restarting this script — only by deleting
# data/shadow-run.json yourself. If you want to start the 72h window over,
# delete that file first.
#
# Usage: scripts/start-shadow.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "hood-traders: starting SHADOW run (paper mode, real market data, no real funds)"
if [ -f ./data/shadow-run.json ]; then
  echo "shadow-run.json already exists — the 72h clock continues from where it left off (see src/gates/shadow-run.ts)."
else
  echo "no prior shadow-run.json found — the 72h clock starts now."
fi

export HOOD_TRADERS_LIVE=0
exec npm run fleet
