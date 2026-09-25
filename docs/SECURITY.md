# Security

## Secrets

- `ROBINHOOD_CHAIN_PRIVATE_KEY` is read from the environment only — never written to code, logs,
  or the dashboard. Use a **burner wallet holding only the $1,000 V1 trading capital**, never a
  treasury key.
- CI runs `gitleaks` on every push (`.github/workflows/ci.yml`) and `.husky/pre-commit` runs a
  best-effort local scan before every commit. `npm run check-launch-gate` runs the same scan
  before allowing live trading (see `docs/LIVE_TRADING.md`).
- `npm run audit:deps` (`npm audit --omit=dev --audit-level=high`) checks only production
  dependencies — `better-sqlite3`, `hoodchain`, `viem`, `ws`.

## Contract risk scanning (`src/security/contract-risk.ts`)

`scanContractRisk()` does real behavioral checks against a live RPC, not selector-presence
guessing: EIP-1967 proxy detection via the actual storage slot, a real `owner()`/`paused()` call,
and a real `eth_call` mint-access probe from a throwaway address
(`OUTSIDER_PROBE_ADDRESS`) to see if an arbitrary outsider can mint. Verified live against
mainnet WETH (0 risk) and USDG (correctly flags an active owner).

## Sellability and liquidity (`src/security/sellability.ts`, `liquidity.ts`)

A real buy-quote → sell-quote round trip at multiple probe sizes ($10 through $1,000) before any
capital is risked, generalized from `launch-sniper`'s original inline honeypot check.

## The probe gate — real money as the final check

Simulation-based checks above can still miss a honeypot with a hidden second sell-blocking
mechanism. `src/execution/probe-gate.ts` (wired into `Agent.processIntent`, see
`docs/ARCHITECTURE.md`) forces a real $2 buy-then-sell before any token's first full-size live
order — a failure there blacklists the token permanently, with no `unblacklist()` method anywhere
in the codebase.

## Privilege separation — the LLM never touches money

`src/decision/jev-adapter.ts` and `src/framework/llm.ts` call out to an LLM provider for a
structured verdict only. No code path lets an LLM response reach `Executor.execute()`,
`sendTransaction`, or a private key directly — every LLM verdict is just another input to the same
`RiskEngine`/`CircuitBreaker`/`checkAccountRisk` gates every other strategy goes through. A failed
or unavailable LLM call resolves `{verdict: null}` and is treated as "no signal," never an implicit
BUY (`src/decision/ensemble.ts`'s fail-closed `jev_unavailable_fail_closed` path).

## The Risk Engine is always supreme

`RiskEngine.check()` runs first, before the circuit breaker, before account-wide risk, before the
probe gate, before execution — for every single intent, every strategy, every mode. Nothing in
this codebase can construct a live order without passing through it; there is no code path that
calls `Executor.execute()` other than `Agent.processIntent()` after every gate above has passed.

## Dashboard

`src/main.ts` binds the dashboard/kill-switch HTTP server to `127.0.0.1` by default
(`DASHBOARD_HOST`, `src/framework/config.ts`) — verified with a real `lsof` check, not assumed.
It is only exposed to other hosts if `DASHBOARD_HOST=0.0.0.0` is set explicitly, which
`docker-compose.yml` does (the container's own network boundary is what actually controls exposure
there, via `ports:` and the host firewall) — bare-metal deployments should leave it unset.

## Reporting a vulnerability

This is a self-funded, personal trading system, not a service with external users — there is no
public bug bounty program. If you find an issue in the forked-from repository's logic, open an
issue at the upstream `nirholas/robinhood-chain-trading-bot` repository.
