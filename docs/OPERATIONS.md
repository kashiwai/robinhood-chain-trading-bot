# Operations

## Scripts (`scripts/`)

| Script | Purpose | Data dir | Default port |
|---|---|---|---|
| `start-shadow.sh` | Start the 72h shadow run (paper mode, real data, no funds) | `data/shadow/` | 4671 |
| `start-paper.sh` | Accumulate closed paper trades — a SEPARATE process from shadow (Level 10.1) | `data/paper/` | 4672 |
| `start-probe.sh` | Live mode, real funds, deliberately tiny per-agent/day caps, for the 20-cycle probe phase | `data/probe/` | 4673 |
| `start-live.sh` | Full-scale live mode at the real $1,000 risk profile | `data/live/` | 4670 |
| `check-launch-gate.mjs` (`npm run check-launch-gate`) | Runs the real unit/replay/secret-scan checks, writes `<phase dir>/launch-gate-status.json` |
| `backup.sh` | Copies every SQLite store + the shadow-run clock for EVERY phase directory found under the target, writes each phase's own `backup-status.json` |
| `restore.sh` | Restores from a `backup.sh` output directory, with an explicit confirmation prompt |
| `kill.sh` | Trips the kill switch by writing the KILL file — works even if the dashboard is unreachable |
| `check-production-checklist.mjs` (`npm run check-production-checklist`) | Audits the spec's full production checklist against the actual repo — PASS/MANUAL/GAP per item, never a fabricated pass |

`start-live.sh` and `restore.sh` both require typing `YES` at a confirmation prompt — neither
accepts a `--yes`/`--force` flag, deliberately.

## Day-to-day sequence

```
scripts/start-shadow.sh        # data/shadow/ — let run >=72h, >=95% uptime
scripts/start-paper.sh         # data/paper/ — can run AT THE SAME TIME as shadow (Level 10.1)
npm run check-launch-gate      # refresh the test/replay/secret-scan evidence
scripts/backup.sh ./data        # backs up shadow/paper/probe/live in one pass
                                # once shadow+paper pass:
scripts/start-probe.sh          # data/probe/ — >=20 real $2 probe cycles, all reconciled
scripts/start-live.sh           # data/live/ — reads shadow/paper/probe evidence, full scale
```

Check gate status at any time without starting the fleet by reading each phase's
`launch-gate-status.json` / `backup-status.json` / `shadow-run.json` directly under `data/<phase>/`,
or by attempting a live-mode boot — `src/main.ts` prints every current blocker before exiting.

## Release Candidates (Level 10.1)

Tag the commit you intend to validate as an RC (e.g. `git tag v0.1.0-rc1`) before starting the
72h shadow run. If you change code or trading-affecting config **during** the validation window,
the build fingerprint (`docs/LIVE_TRADING.md`) will correctly reject the stale evidence at the
`live` gate check — tag a new RC (`v0.1.0-rc2`) and, depending on what changed, re-run only the
affected phases (a docs-only change may not need a re-run at all if you list its SHA in
`LAUNCH_GATE_ALLOWED_PRIOR_SHAS`; a strategy/risk-profile change requires fresh shadow/paper/probe
evidence).

## Telegram (`src/alerts/`) — critical alerts + read-only remote control

Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (see `.env.example`) to enable. The admin chat is
fixed at config-load time — a message from any other chat is silently ignored, not even
acknowledged. Sends `BOT_START`/`BOT_STOP`/`LIVE_GATE_REJECTED`/`PROBE_START`/`PROBE_PASS`/
`PROBE_FAIL`/`REAL_BUY`/`REAL_SELL`/`EMERGENCY_EXIT`/`SELL_FAILURE`/`CIRCUIT_BREAKER`/
`DAILY_LOSS_LIMIT`/`DRAWDOWN_LIMIT`/`RPC_PRIMARY_DOWN`/`ALL_RPC_DOWN`/`DB_FAILURE`/
`RECONCILIATION_FAILURE`/`KILL_SWITCH` — every send is best-effort (a Telegram outage never blocks
or crashes the trading loop).

Commands (admin chat only): `/status` (mode, killed state, equity, daily spend), `/positions`
(every open position across every agent), `/pause` (trips the `manual_pause` circuit-breaker
condition — blocks new BUYs fleet-wide, sells and existing positions unaffected). **`/resume` is
permanently disabled by design** — no code path clears a breaker or the kill switch from Telegram;
use the dashboard or restart the process. No command anywhere reaches a buy/sell path — verified in
`tests/unit/telegram-commands.test.ts`.

## Monitoring

- Dashboard: `http://127.0.0.1:<port>` by default, per-phase port above (see `docs/SECURITY.md` for
  the bind-address guarantee) — live fleet summary, per-agent status, trade journal.
- Logs: plain stdout/stderr — `docker compose logs -f` or your process manager's log capture.
- RPC health: printed in the live-mode "SYSTEM READY" banner and re-evaluated every 15 seconds
  (feeds the `rpc_unhealthy` circuit breaker, the shadow-run uptime clock, and the Telegram
  `RPC_PRIMARY_DOWN`/`ALL_RPC_DOWN` alerts).

## Scaling caps after the initial live launch

`AGENT_MAX_POSITION_USDG`, `AGENT_MAX_DAILY_SPEND_USDG`, `FLEET_MAX_DAILY_SPEND_USDG` (see
`.env.example`) are ordinary env vars — raise them gradually as live performance data
accumulates, rather than jumping straight to the $1,000 account's full per-position/per-day caps.
`scripts/start-probe.sh`'s defaults (`$10`/`$20`/`$30`) are a reasonable starting point, not a
hard floor.
