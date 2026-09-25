# Operations

## Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `start-shadow.sh` | Start the 72h shadow run (paper mode, real data, no funds) |
| `start-paper.sh` | Same process as shadow — accumulates closed paper trades too |
| `start-probe.sh` | Live mode, real funds, deliberately tiny per-agent/day caps, for the 20-cycle probe phase |
| `start-live.sh` | Full-scale live mode at the real $1,000 risk profile |
| `check-launch-gate.mjs` (`npm run check-launch-gate`) | Runs the real unit/replay/secret-scan checks, writes `data/launch-gate-status.json` |
| `backup.sh` | Copies every SQLite store + the shadow-run clock to `data/backups/<timestamp>/`, writes `data/backup-status.json` |
| `restore.sh` | Restores from a `backup.sh` output directory, with an explicit confirmation prompt |
| `kill.sh` | Trips the kill switch by writing the KILL file — works even if the dashboard is unreachable |
| `check-production-checklist.mjs` (`npm run check-production-checklist`) | Audits the spec's full production checklist against the actual repo — PASS/MANUAL/GAP per item, never a fabricated pass |

`start-live.sh` and `restore.sh` both require typing `YES` at a confirmation prompt — neither
accepts a `--yes`/`--force` flag, deliberately.

## Day-to-day sequence

```
scripts/start-shadow.sh        # let run >=72h, >=95% uptime
                                # (this IS scripts/start-paper.sh — same process)
npm run check-launch-gate      # refresh the test/replay/secret-scan evidence
scripts/backup.sh               # refresh backup evidence
                                # once the gate reports ready — see below:
scripts/start-probe.sh          # >=20 real $2 probe cycles, all reconciled
scripts/start-live.sh           # full scale
```

Check gate status at any time without starting the fleet by reading
`data/launch-gate-status.json` / `data/backup-status.json` / `data/shadow-run.json` directly, or
by attempting a live-mode boot — `src/main.ts` prints every current blocker before exiting.

## Monitoring

- Dashboard: `http://127.0.0.1:4670` by default (see `docs/SECURITY.md` for the bind-address
  guarantee) — live fleet summary, per-agent status, trade journal.
- Logs: plain stdout/stderr — `docker compose logs -f` or your process manager's log capture.
- RPC health: printed in the live-mode "SYSTEM READY" banner and re-evaluated every 15 seconds
  (feeds both the `rpc_unhealthy` circuit breaker and the shadow-run uptime clock).

## Scaling caps after the initial live launch

`AGENT_MAX_POSITION_USDG`, `AGENT_MAX_DAILY_SPEND_USDG`, `FLEET_MAX_DAILY_SPEND_USDG` (see
`.env.example`) are ordinary env vars — raise them gradually as live performance data
accumulates, rather than jumping straight to the $1,000 account's full per-position/per-day caps.
`scripts/start-probe.sh`'s defaults (`$10`/`$20`/`$30`) are a reasonable starting point, not a
hard floor.
