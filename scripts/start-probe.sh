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
# The in-process Launch Gate (src/main.ts) still refuses to boot into live
# mode at all unless the shadow/paper/probe evidence is real and sufficient —
# this script does not and cannot bypass that.
#
# Usage: scripts/start-probe.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${HOOD_TRADERS_LIVE:?set HOOD_TRADERS_LIVE=1 before running this script}"
: "${ROBINHOOD_CHAIN_PRIVATE_KEY:?set ROBINHOOD_CHAIN_PRIVATE_KEY before running this script}"
: "${LIVE_ACKNOWLEDGED:?set LIVE_ACKNOWLEDGED=YES before running this script — this trades real funds}"

export AGENT_MAX_POSITION_USDG="${AGENT_MAX_POSITION_USDG:-10}"
export AGENT_MAX_DAILY_SPEND_USDG="${AGENT_MAX_DAILY_SPEND_USDG:-20}"
export FLEET_MAX_DAILY_SPEND_USDG="${FLEET_MAX_DAILY_SPEND_USDG:-30}"

echo "hood-traders: starting PROBE phase — LIVE mode, real funds, deliberately small caps:"
echo "  AGENT_MAX_POSITION_USDG=$AGENT_MAX_POSITION_USDG AGENT_MAX_DAILY_SPEND_USDG=$AGENT_MAX_DAILY_SPEND_USDG FLEET_MAX_DAILY_SPEND_USDG=$FLEET_MAX_DAILY_SPEND_USDG"
echo "the Launch Gate inside the process will still refuse to start unless shadow/paper evidence is real and sufficient."
exec npm run fleet
