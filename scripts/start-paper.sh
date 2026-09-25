#!/usr/bin/env bash
# Starts the fleet in paper mode to accumulate closed paper trades (spec
# 10-C: >=200 closed paper trades before live). This is the SAME process as
# scripts/start-shadow.sh — a running paper-mode fleet accumulates BOTH the
# shadow-run uptime clock AND paper trade count simultaneously, since they're
# read from the same journal/shadow-run.json. This script exists as a
# separate, clearly-named entry point because the spec names it separately;
# functionally there is nothing to choose between the two.
#
# Usage: scripts/start-paper.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "hood-traders: starting PAPER trading (simulated fills, no real funds)"
export HOOD_TRADERS_LIVE=0
exec npm run fleet
