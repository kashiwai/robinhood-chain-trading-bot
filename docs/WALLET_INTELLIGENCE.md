# Wallet Intelligence

## Transfer classification (`src/intelligence/classify.ts`)

`classifyTransfer({from, to}, dexAddresses)` → `buy` / `sell` / `transfer`, from real ERC-20
`Transfer` event `from`/`to` addresses against the known DEX/router/pool address set. Documented
blind spots, not hidden ones: a wallet-to-unrecognized-aggregator transfer undercounts (fails
safe — treated as a plain transfer, never miscounted as a trade); an aggregator-to-pool transfer
IS classified as a sell but attributed to the aggregator contract, not the real trader behind it.

## FIFO cost basis (`src/intelligence/wallet-store.ts`)

`WalletStore` tracks `open_lots` per wallet per token, consumed first-in-first-out on each sell,
producing real realized PnL — the same accounting method used identically in
`src/analytics/performance.ts` for the bot's own trade PnL, so wallet scores and the bot's own
performance numbers are directly comparable. `recordTrade()` wraps the transfer insert, lot
consumption, and stats update in one SQLite transaction — never a partially-applied trade.

## Wallet scoring (`src/intelligence/wallet-score.ts`)

`computeWalletScore()` — six weighted components summing to exactly 100 (asserted in
`tests/unit/wallet-score.test.ts`): 25 realized PnL, 20 profit factor, 15 win rate, 15 early-entry
tendency, 10 rug-avoidance, 10 consistency, 5 sample-size confidence. `confidence()` ramps linearly
to 1.0 at 50 total trades — a wallet with 2 trades and a perfect record is not scored as highly as
one with 50.

## Funder clustering (`src/intelligence/entity-cluster.ts`, `cluster-signal.ts`)

`EntityCluster` answers "are these N buying wallets actually N independent people, or one entity
fanning capital across throwaway wallets?" — by tracing each wallet's funding source
(`resolveFunder()`, `src/intelligence/funding-graph.ts`) and union-finding wallets that share a
funder.

The union-find is **rebuilt from the raw edge list on every query**, not eagerly merged and left
that way — a funder whose fan-out crosses `maxFunderFanOut` (default 5) is excluded
**retroactively**, un-merging wallets it was falsely grouped with even if the exclusion threshold
was only crossed by a later transaction. An earlier, eager-union design was caught and fixed
during testing precisely because it got this wrong: the first 5 recipients of a mass-distributing
funder stayed falsely merged even after a 6th delivery revealed the pattern.

`computeClusterSignal()` turns a set of buys into a 0-100 score
(`independenceRatio*40 + combinedStrength*40 + timeTightness*20`), calibrated against the spec's
own worked example. An empty buy list scores 0, not a vacuous "perfectly tight" — a second real
bug caught in testing, where a zero-length timestamp array originally read as
`timeTightness: 1`.

## Where this feeds decisions

`src/decision/candidate-evaluator.ts` reads `WalletStore.recentBuyers()`/`recentTransfers()` and
`EntityCluster.independentEntityCount()` directly into the Level 8 feature vector's
`independent_wallet_count` and `smart_wallet_count` fields — see `docs/JEV.md` for how those feed
the ensemble. As with the rest of the Level 8 decision engine, this is built and tested but not
yet called from `launch-sniper.ts`'s live decision path.
