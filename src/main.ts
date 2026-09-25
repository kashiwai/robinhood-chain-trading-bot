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
  const launchDetector = new LaunchDetector({
    rpc,
    queue: discoveryQueue,
    chainId,
    onError: (e) => console.warn(`discovery: ${e.message}`),
  })
  rpc.start()
  await launchDetector.start()

  const agentIds = ['sniper-1', 'momentum-1', 'premium-1']
  fleet.addAgents([
    { id: 'sniper-1', strategy: new LaunchSniper({}, discoveryQueue), tickIntervalMs: 4000 },
    { id: 'momentum-1', strategy: new Momentum(), tickIntervalMs: 15000 },
    { id: 'premium-1', strategy: new PremiumWatch(), tickIntervalMs: 30000 },
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
    rpc.stop()
    discoveryQueue.close()
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
