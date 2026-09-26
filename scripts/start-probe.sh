#!/usr/bin/env bash
# Starts LIVE trading with deliberately tiny risk caps for the spec's 10-D
# probe validation phase (>=20 real $2 probe cycles, all reconciled, before
# scaling up). This is NOT a separate code path from full live trading — the
# probe gate (src/execution/probe-gate.ts) is wired into EVERY live boot and
# runs a real $2 buy/sell round trip before any token's first full-size
# order, always. This script just keeps the blast radius small while that
# trust is being built, by defaulting the per-agent/day caps low unless you've
# already set them yourself.
#
# Requires the same three live-mode conditions as scripts/start-live.sh:
# HOOD_TRADERS_LIVE=1, ROBINHOOD_CHAIN_PRIVATE_KEY, LIVE_ACKNOWLEDGED=YES.
#
# Level 10.1: runs under HOOD_RUN_PHASE=probe, scoping every SQLite store
# under data/probe/ (separate from data/shadow/, data/paper/, data/live/).
# The Launch Gate is NOT evaluated for this phase — probe evidence is one of
# the gate's own prerequisites, so gating this phase against itself would be
# circular. Only scripts/start-live.sh's `live` phase is actually gated —
# and it reads THIS phase's data/probe/ evidence to decide whether it's ready.
#
# Usage: scripts/start-probe.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${HOOD_TRADERS_LIVE:?set HOOD_TRADERS_LIVE=1 before running this script}"
: "${ROBINHOOD_CHAIN_PRIVATE_KEY:?set ROBINHOOD_CHAIN_PRIVATE_KEY before running this script}"
: "${LIVE_ACKNOWLEDGED:?set LIVE_ACKNOWLEDGED=YES before running this script — this trades real funds}"

export HOOD_RUN_PHASE=probe
export AGENT_MAX_POSITION_USDG="${AGENT_MAX_POSITION_USDG:-10}"
export AGENT_MAX_DAILY_SPEND_USDG="${AGENT_MAX_DAILY_SPEND_USDG:-20}"
export FLEET_MAX_DAILY_SPEND_USDG="${FLEET_MAX_DAILY_SPEND_USDG:-30}"
export DASHBOARD_PORT="${DASHBOARD_PORT:-4673}"

echo "hood-traders: starting PROBE phase — LIVE mode, real funds, deliberately small caps:"
echo "  AGENT_MAX_POSITION_USDG=$AGENT_MAX_POSITION_USDG AGENT_MAX_DAILY_SPEND_USDG=$AGENT_MAX_DAILY_SPEND_USDG FLEET_MAX_DAILY_SPEND_USDG=$FLEET_MAX_DAILY_SPEND_USDG"
echo "data is stored under data/probe/ — start-live.sh reads it from there when checking the Launch Gate."
exec npm run fleet
