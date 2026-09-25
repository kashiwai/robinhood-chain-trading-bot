#!/usr/bin/env bash
# Trips the global kill switch (src/framework/kill.ts) by creating the file
# every running fleet process polls for. Works even if the dashboard's
# POST /api/kill endpoint is unreachable — this is the "break glass" path.
#
# Usage: scripts/kill.sh [path to KILL file, default ./data/KILL]
set -euo pipefail

KILL_FILE="${1:-${KILL_FILE:-./data/KILL}}"
mkdir -p "$(dirname "$KILL_FILE")"
echo "killed at $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/kill.sh" > "$KILL_FILE"
echo "kill switch tripped: $KILL_FILE"
echo "every running agent refuses ALL new orders (buys AND sells) immediately; open positions are left as-is — unwinding is a separate, explicit operator action."
