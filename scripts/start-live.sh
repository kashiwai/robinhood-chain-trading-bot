#!/usr/bin/env bash
# Starts FULL-SCALE live trading with real funds, at the risk profile's real
# $1,000-account caps (src/risk/risk-profile.ts DEFAULT_RISK_PROFILE) — no
# artificial size reduction, unlike scripts/start-probe.sh.
#
# This script is a thin, honest wrapper: it checks the three explicit-consent
# env vars are set and prints what's about to happen. It is NOT the safety
# boundary. The real boundary is src/main.ts's in-process Launch Gate check,
# which reads REAL evidence (shadow-run hours/uptime, closed paper trades,
# reconciled probe cycles, a recent backup, a clean test/security run, and a
# Level 10.1 build-fingerprint match against that evidence) and refuses to
# sign a single live transaction unless every one of those is actually true —
# this script cannot bypass that, and does not try to.
#
# Level 10.1: runs under HOOD_RUN_PHASE=live, scoping every SQLite store
# under data/live/. The Launch Gate reads its evidence from the SIBLING
# data/shadow/, data/paper/, and data/probe/ directories — this phase never
# writes into those, only reads from them.
#
# Usage: scripts/start-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${HOOD_TRADERS_LIVE:?set HOOD_TRADERS_LIVE=1 before running this script}"
: "${ROBINHOOD_CHAIN_PRIVATE_KEY:?set ROBINHOOD_CHAIN_PRIVATE_KEY before running this script}"
: "${LIVE_ACKNOWLEDGED:?set LIVE_ACKNOWLEDGED=YES before running this script — this trades real funds at full size}"

export HOOD_RUN_PHASE=live

echo "─────────────────────────────────────────────────────────"
echo " hood-traders — FULL LIVE TRADING"
echo " This will sign and broadcast REAL transactions with REAL funds."
echo " Ctrl-C or scripts/kill.sh halts new orders immediately."
echo "─────────────────────────────────────────────────────────"
read -r -p "Type YES to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "start-live: aborted (confirmation not given)"
  exit 1
fi

exec npm run fleet
