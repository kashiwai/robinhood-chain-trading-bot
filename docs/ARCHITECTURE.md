# Architecture

See also [`docs/architecture.html`](architecture.html) for the observe → decide → simulate →
risk-check → execute → journal pipeline diagram referenced from the README.

## Layers

```
discovery/      real-time launch detection: durable event queue + reorg guard + RPC-redundant watcher
intelligence/   wallet classification, FIFO cost basis, wallet scoring, funder clustering
security/       contract risk scan, sellability probe, liquidity depth, hard-reject rules
decision/       feature vector -> rule engine + LLM judge (JEV) -> 5-mode ensemble
execution/      order lifecycle, nonce management, fill reconciliation, $2 first-buy probe gate
risk/           per-$1,000-account risk profile, account-wide risk gate, 9-condition circuit breaker
exits/          tiered take-profit/stop-loss/trailing exit engine, 7-condition emergency exit
framework/      Agent (strategy + risk + execution loop), Fleet (multi-agent + account risk), Journal
gates/          Level 10 launch gate: shadow-run clock, evidence collection, all-or-nothing evaluation
strategies/     launch-sniper, momentum, premium-watch, llm-strategist
analytics/      FIFO trade performance, strategy comparison, parameter-change suggestions (never auto-applied)
```

## The per-tick pipeline (`src/framework/agent.ts`)

```
Strategy.tick(ctx) ──► Decision { intents[], alerts[] }
   │
   ▼
for each intent:
  1. simulate      — real QuoterV2 eth_call, no state change
  2. price          — USD notional from the simulated fill
  3. risk gate       — RiskEngine.check(...) — fails CLOSED (kill switch, cooldown, position/spend caps)
  4. [buy only] circuit breaker + account-wide risk gate (Level 7)
  5. [buy only, live, first position] probe gate — real $2 round trip before any full-size order (Level 10)
  6. execute         — paper: record the simulated fill
                        live:  Executor (order lifecycle + nonce + fill reconciliation) or the
                               plain inline sign-and-submit fallback when no Executor is wired
  7. journal          — every trade AND every refusal, into SQLite
```

A strategy proposes intents; it never executes directly and cannot bypass any gate above.

## Decision engine (Levels 8-9, built but not wired into the live path)

`src/decision/candidate-evaluator.ts` orchestrates the full feature-vector → 5-mode ensemble
pipeline (RULE / RULE_JEV / JEV_ONLY / JEV_SMART_WALLET / JEV_SMART_WALLET_CLUSTER) against real
RPC + store data. It is fully built and unit-tested but **intentionally not called from
`launch-sniper.ts`** — `LaunchSniper`'s live decisions still come from its own Level 1-2 signal
logic plus the Level 9 exit engine. Wiring the ensemble into a strategy's live decision path is
future work, not a claimed-but-missing feature — see the module's own doc comment.

## Why discovery-path and execution-path RPC redundancy are separate

`src/chain/rpc-manager.ts`'s `RpcManager` (primary wss / secondary http / emergency public tiers)
backs `discovery/launch-detector.ts` and `intelligence/wallet-tracker.ts` only. `Fleet.market`
(execution/quoting) uses its own single client — see the doc comment on `RpcManager` for the
reasoning: a failover mid-signature would be far more dangerous than a failover mid-poll.

## Persistence

Every durable store (`OrderStore`, `ProbeStore`, `EventQueue`, `WalletStore`, `Journal`) is a
separate WAL-mode SQLite file under the data directory, keyed by a caller-supplied idempotency key
with `INSERT OR IGNORE` semantics — duplicate processing is structurally prevented, not merely
discouraged. Bigints are always stored as decimal TEXT (SQLite's native INTEGER is 64-bit signed
and overflows real on-chain amounts).
