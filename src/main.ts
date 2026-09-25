import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFleetConfig, loadLlmConfig, loadLlmMinConfidence } from './framework/config.js'
import { Fleet } from './framework/fleet.js'
import { LaunchSniper } from './strategies/launch-sniper.js'
import { Momentum } from './strategies/momentum.js'
import { PremiumWatch } from './strategies/premium-watch.js'
import { LlmStrategist } from './strategies/llm-strategist.js'
import { createDashboardServer } from './server/dashboard.js'
import { RpcManager } from './chain/rpc-manager.js'
import { EventQueue } from './discovery/event-queue.js'
import { LaunchDetector } from './discovery/launch-detector.js'
import { WalletStore } from './intelligence/wallet-store.js'
import { WalletTracker, dexAddressesForToken } from './intelligence/wallet-tracker.js'
import { resolveFunder } from './intelligence/funding-graph.js'
import { EntityCluster } from './intelligence/entity-cluster.js'
import { OrderStore } from './execution/order-store.js'
import { NonceManager } from './execution/nonce-manager.js'
import { Executor, recoverPendingOrders } from './execution/executor.js'
import {
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  swapAddresses,
  type Launch,
} from 'hoodchain'

// main.ts sits at a stable one-level depth in both trees: src/main.ts (tsx,
// dev) and dist/main.js (tsup bundle, prod) — so "one level up + dashboard"
// resolves correctly in both without guessing at bundler output shape.
const DASHBOARD_STATIC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dashboard')

async function main(): Promise<void> {
  const config = loadFleetConfig()
  const fleet = new Fleet(config)

  // ── discovery: durable event queue + RPC-redundant launch watcher ──────────
  // Independent of `fleet.market` (the execution/quoting client) — see
  // src/chain/rpc-manager.ts's doc comment for why discovery-path and
  // execution-path RPC redundancy are kept separate.
  if (!config.rpcUrl && !config.wsRpcUrl) {
    console.warn(
      'discovery: no HOOD_RPC_URL/HOOD_WS_RPC_URL set — running against the free public RPC only. ' +
        'Verified directly: that endpoint rate-limits real launch-watching traffic (429s under normal ' +
        'polling load). Set one of those two in .env for reliable discovery; see .env.example.',
    )
  }
  const discoveryDbPath =
    config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'discovery.db')
  const discoveryQueue = new EventQueue(discoveryDbPath)
  const rpc = RpcManager.create({
    network: config.network,
    wsRpcUrl: config.wsRpcUrl,
    httpRpcUrl: config.rpcUrl,
    stockTokenEligible: config.stockTokenEligible,
  })
  const chainId = config.network === 'testnet' ? 46630 : 4663

  // ── wallet intelligence: classify every buy/sell on each discovered launch ─
  const walletDbPath = config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'wallets.db')
  const walletStore = new WalletStore(walletDbPath)
  // Level 4: who funded a wallet's first trade — resolved once, on first
  // sight, and folded into the shared entity graph so "3 wallets bought"
  // can be told apart from "1 entity bought through 3 wallets" (see
  // intelligence/entity-cluster.ts).
  const entityCluster = new EntityCluster()
  const quoteTokensForFunding = [fleet.market.weth, fleet.market.usdg]
  const walletTracker = new WalletTracker({
    client: rpc.active,
    market: fleet.market,
    store: walletStore,
    chainId,
    onError: (e) => console.warn(`wallet-tracker: ${e.message}`),
    onFirstTrade: (wallet) => {
      void resolveFunder(rpc.active, wallet, quoteTokensForFunding)
        .then((edge) => {
          if (edge) entityCluster.recordFunding(edge.funder, wallet)
        })
        .catch((e: unknown) => console.warn(`funding-graph: ${e instanceof Error ? e.message : String(e)}`))
    },
  })
  const swapAddrs = swapAddresses(fleet.market.client)
  // testnet has no official Uniswap deployment (see hoodchain's own docs on
  // TESTNET_ADDRESSES) and so lacks a universalRouter — every other address
  // here is present on both networks.
  const universalRouter = config.network === 'mainnet' ? MAINNET_ADDRESSES.universalRouter : undefined
  const chainAddrs = config.network === 'testnet' ? TESTNET_ADDRESSES : MAINNET_ADDRESSES
  const sharedDexInfra = [
    swapAddrs.router,
    swapAddrs.quoterV2,
    universalRouter,
    chainAddrs.nonfungiblePositionManager,
    NOXA_ADDRESSES.launchFactory,
    NOXA_ADDRESSES.locker,
    NOXA_ADDRESSES.feeRouter,
    ODYSSEY_ADDRESSES.bondingCurveFactory,
    ODYSSEY_ADDRESSES.instantFactory,
    ODYSSEY_ADDRESSES.reflectionFactory,
    ODYSSEY_ADDRESSES.legacyFactory,
  ].filter((a): a is `0x${string}` => a !== undefined)

  const launchDetector = new LaunchDetector({
    rpc,
    queue: discoveryQueue,
    chainId,
    onError: (e) => console.warn(`discovery: ${e.message}`),
    onLaunch: (launch: Launch) => {
      void walletTracker.track({
        token: launch.token,
        dexAddresses: dexAddressesForToken(launch.pool, sharedDexInfra),
        launchDetectedAtMs: Date.now(),
      })
    },
  })
  rpc.start()
  await launchDetector.start()

  // ── Level 6: execution engine (live mode only — paper mode never touches this) ──
  const orderDbPath = config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'orders.db')
  const orderStore = new OrderStore(orderDbPath)
  let executor: Executor | undefined
  if (config.mode === 'live' && fleet.market.client.account) {
    const account = fleet.market.client.account
    const nonceManager = new NonceManager(fleet.market.client, account.address)
    await nonceManager.sync()
    executor = new Executor({
      client: fleet.market.client,
      account,
      orderStore,
      nonceManager,
      onError: (e) => console.warn(`executor: ${e.message}`),
    })

    const recovery = await recoverPendingOrders(fleet.market.client, orderStore, () => ({
      account: account.address,
    }))
    if (recovery.recovered || recovery.failed || recovery.stillPending) {
      console.log(
        `order recovery: ${recovery.recovered} reconciled, ${recovery.failed} failed, ${recovery.stillPending} still pending from a prior run`,
      )
    }
  }

  const agentIds = ['sniper-1', 'momentum-1', 'premium-1']
  fleet.addAgents([
    { id: 'sniper-1', strategy: new LaunchSniper({}, discoveryQueue), tickIntervalMs: 4000, executor },
    { id: 'momentum-1', strategy: new Momentum(), tickIntervalMs: 15000, executor },
    { id: 'premium-1', strategy: new PremiumWatch(), tickIntervalMs: 30000, executor },
  ])

  const llm = loadLlmConfig()
  if (llm) {
    fleet.addAgents([
      {
        id: 'llm-1',
        strategy: new LlmStrategist({ llm, minConfidence: loadLlmMinConfidence() }),
        tickIntervalMs: 20000,
      },
    ])
    agentIds.push('llm-1')
  } else {
    console.warn(
      'HOOD_LLM_PROVIDER/HOOD_LLM_API_KEY not set: llm-strategist disabled (the other 3 strategies still run).',
    )
  }

  const banner = [
    '─'.repeat(60),
    ' hood-traders — Robinhood Chain autonomous fleet',
    '─'.repeat(60),
    ` network   : ${config.network} (${config.network === 'testnet' ? 46630 : 4663})`,
    ` mode      : ${config.mode.toUpperCase()}${config.mode === 'paper' ? ' (simulation only, no real funds move)' : ' (REAL FUNDS — swaps will be signed and broadcast)'}`,
    ` agents    : ${agentIds.join(', ')}`,
    ` fleet cap : $${config.fleetMaxDailySpendUsdg}/day`,
    ` dashboard : http://localhost:${config.dashboardPort}`,
    ` kill file : ${config.killFile}`,
    '─'.repeat(60),
  ].join('\n')
  console.log(banner)

  if (config.mode === 'live') {
    console.warn(
      '\n⚠ LIVE MODE — this process will sign and broadcast real transactions with real funds.\n' +
        '  Risk caps are active but are not a guarantee against loss. Ctrl-C or POST /kill to halt.\n',
    )
  }

  await fleet.start()

  const server = createDashboardServer(fleet, DASHBOARD_STATIC_ROOT)
  server.listen(config.dashboardPort, () => {
    console.log(`dashboard listening on :${config.dashboardPort}`)
  })

  const shutdown = () => {
    console.log('\nshutting down — stopping agents, closing journal…')
    launchDetector.stop()
    walletTracker.stop()
    rpc.stop()
    discoveryQueue.close()
    walletStore.close()
    orderStore.close()
    server.close()
    fleet.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('hood-traders fatal error:', err)
  process.exit(1)
})
