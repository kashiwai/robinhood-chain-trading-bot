# Incident Response

## Immediate halt

```bash
scripts/kill.sh                 # writes the KILL file — every agent refuses ALL new orders
# or: Ctrl-C / docker compose stop (SIGINT/SIGTERM — same effect)
# or: curl -X POST http://127.0.0.1:4670/api/kill
```

The kill switch **never sells or unwinds automatically** — it halts new risk only. See
`src/framework/kill.ts`'s own doc comment: a forced market-sell into thin liquidity during
whatever caused the panic is usually worse than holding. Unwinding open positions after a kill is
a deliberate, separate operator action.

## Common scenarios

**RPC endpoint down / unhealthy**
`rpc_unhealthy` circuit breaker trips automatically (`src/main.ts`'s 15s health poll) — new buys
pause fleet-wide, sells continue. Check `rpc.healthSnapshot()` via the dashboard; add a working
`HOOD_RPC_URL`/`HOOD_WS_RPC_URL` and restart if the default public RPC is the one failing.

**A live order's `sendTransaction` call is ambiguous (timed out / errored mid-broadcast)**
`Executor` tracks this with a `broadcastAttempted` flag distinct from order state — the nonce is
NOT released in this case (a released-then-reused nonce on an actually-broadcast tx risks a double
spend). On restart, `recoverPendingOrders()` reconciles against real chain state and never
auto-resubmits — it only marks orders that genuinely never got a txHash as `FAILED`, and leaves
anything ambiguous pending for a human to check against a block explorer.

**A newly-launched token fails its $2 probe**
It is permanently blacklisted (`src/execution/probe-store.ts` — no `unblacklist()` method exists).
If you believe the blacklist is wrong (e.g. a transient RPC error during the probe, not a real
honeypot), the only path back is a direct SQL `UPDATE`/`DELETE` against `probes.db` — deliberately
not a one-line API, since un-blacklisting a token that failed a real money round trip should be
rare and deliberate.

**Suspected compromised private key**
1. `scripts/kill.sh` immediately.
2. Move remaining funds out with a separate wallet/tool you trust — this codebase has no
   "sweep funds to a safe address" function, on purpose (a compromised process is not somewhere
   you want to also run the sweep).
3. Rotate `ROBINHOOD_CHAIN_PRIVATE_KEY` to a new burner wallet before ever restarting.
4. Treat `data/launch-gate-status.json` and the shadow-run clock as untrusted going forward if the
   host itself may have been compromised — start the Shadow phase over.

**Database corruption / unexpected schema state**
Stop the process, restore from the most recent `scripts/backup.sh` output via `scripts/restore.sh`
— see `docs/BACKUP_RECOVERY.md`.

## Postmortem inputs already captured

Every trade AND every refusal is journaled (`src/framework/journal.ts`) with a reason code and
metadata — `journal.recentDecisions(agentId, n)` / `allTradesInMode(mode)` are the first things to
pull when reconstructing what happened. `src/analytics/performance.ts` and
`strategy-comparison.ts` turn that into FIFO PnL and per-mode comparisons without needing to
re-derive anything by hand.
