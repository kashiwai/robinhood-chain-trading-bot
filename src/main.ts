import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEther } from 'viem'
import {
  loadFleetConfig,
  loadLlmConfig,
  loadLlmMinConfidence,
  loadTelegramConfig,
} from './framework/config.js'
import { Fleet } from './framework/fleet.js'
import { Journal, DATABASE_SCHEMA_VERSION } from './framework/journal.js'
import { LaunchSniper, type LaunchSniperParams } from './strategies/launch-sniper.js'
import { Momentum, type MomentumParams } from './strategies/momentum.js'
import { PremiumWatch, type PremiumWatchParams } from './strategies/premium-watch.js'
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
import { ProbeStore } from './execution/probe-store.js'
import { ProbeEngine } from './execution/probe.js'
import { ProbeGate } from './execution/probe-gate.js'
import { CircuitBreaker } from './risk/circuit-breaker.js'
import { loadRiskProfile } from './risk/risk-profile.js'
import { createRealEmergencyMonitor } from './exits/emergency-context.js'
import { TelegramAlerter, type TelegramAlertType } from './alerts/telegram.js'
import { TelegramBot } from './alerts/telegram-bot.js'
import { ShadowRunTracker } from './gates/shadow-run.js'
import { evaluateLaunchGate } from './gates/launch-gate.js'
import { collectLaunchGateEvidence } from './gates/collect-evidence.js'
import { readTestGateStatus, readBackupStatus } from './gates/launch-gate-status.js'
import { computeBuildFingerprint } from './gates/build-fingerprint.js'
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
  const riskProfile = loadRiskProfile()
  const fleet = new Fleet(config, riskProfile)

  // Declared once, up front, so both the strategies constructed later AND
  // the Level 10.1 build fingerprint below read the exact same params —
  // there is no separate "what the fingerprint assumes" vs. "what actually
  // runs" to drift apart.
  const launchSniperParams: Partial<LaunchSniperParams> = {}
  const momentumParams: Partial<MomentumParams> = {}
  const premiumWatchParams: Partial<PremiumWatchParams> = {}

  const chainId = config.network === 'testnet' ? 46630 : 4663
  // Level 10.1: identifies the exact build+config attempting to go live —
  // see gates/build-fingerprint.ts. gitCommitSha changing at all (even a
  // docs-only commit) invalidates prior shadow/paper/probe evidence by
  // default; LAUNCH_GATE_ALLOWED_PRIOR_SHAS is the explicit, narrow escape
  // hatch for a specific, reviewed prior SHA.
  const buildFingerprint = computeBuildFingerprint({
    tradingConfig: {
      fleetMaxDailySpendUsdg: config.fleetMaxDailySpendUsdg,
      stockTokenEligible: config.stockTokenEligible,
      defaultLimits: config.defaultLimits,
      riskProfile,
    },
    strategyParams: { launchSniperParams, momentumParams, premiumWatchParams },
    chainId,
    rpcConfig: { rpcUrl: config.rpcUrl, wsRpcUrl: config.wsRpcUrl, network: config.network },
    databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
  })

  // ── Level 7: circuit breaker (buy-paused / sell-enabled). Only the
  // discovery RPC health condition is auto-wired below for now — the other
  // eight named conditions (database_error, sell_failure, daily_loss_
  // exceeded, drawdown_exceeded, consecutive_losses, price_oracle_
  // disagreement, nonce_failure, reconciliation_mismatch) are fully built
  // and tested (risk/circuit-breaker.ts) but not yet wired to an automatic
  // trigger elsewhere in this codebase — `circuitBreaker.trip(...)` is
  // there for a future level (or the dashboard) to call. Not claiming more
  // automatic coverage than actually exists.
  const circuitBreaker = new CircuitBreaker()

  // ── Level 10.1: Telegram critical alerting + read-only remote control ──────
  // Entirely optional (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). The admin chat
  // is fixed at config-load time — nothing here ever learns a new admin from
  // an incoming message. No command (see alerts/telegram-commands.ts) can
  // reach a buy/sell path; /resume is permanently disabled by design.
  const telegramConfig = loadTelegramConfig()
  const telegramAlerter = telegramConfig
    ? new TelegramAlerter({
        botToken: telegramConfig.botToken,
        chatId: telegramConfig.chatId,
        onError: (e) => console.warn(`telegram: ${e.message}`),
      })
    : undefined
  if (!telegramConfig) {
    console.warn('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set: Telegram alerts and remote control disabled.')
  }

  fleet.kill.onKill((reason) => void telegramAlerter?.send('KILL_SWITCH', `kill switch tripped: ${reason}`))
  circuitBreaker.onTrip((t) => {
    const typeByCondition: Partial<Record<typeof t.condition, TelegramAlertType>> = {
      daily_loss_exceeded: 'DAILY_LOSS_LIMIT',
      drawdown_exceeded: 'DRAWDOWN_LIMIT',
      rpc_unhealthy: 'ALL_RPC_DOWN',
      reconciliation_mismatch: 'RECONCILIATION_FAILURE',
      database_error: 'DB_FAILURE',
    }
    void telegramAlerter?.send(
      typeByCondition[t.condition] ?? 'CIRCUIT_BREAKER',
      `${t.condition}: ${t.detail}`,
    )
  })

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

  // ── wallet intelligence: classify every buy/sell on each discovered launch ─
  const walletDbPath = config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'wallets.db')
  const walletStore = new WalletStore(walletDbPath)
  // Level 4: who funded a wallet's first trade — resolved once, on first
  // sight, and folded into the shared entity graph so "3 wallets bought"
  // can be told apart from "1 entity bought through 3 wallets" (see
  // intelligence/entity-cluster.ts).
  const entityCluster = new EntityCluster()
  const quoteTokensForFunding = [fleet.market.weth, fleet.market.usdg]

  // ── Level 10.1: emergency-exit layer — real Level 5 scans + wallet intelligence, wired into every agent below ──
  const emergencyMonitor = createRealEmergencyMonitor({
    client: fleet.market.client,
    market: fleet.market,
    walletStore,
    probeAmountIn: parseEther('0.01'), // matches LaunchSniper's own default entry size
  })
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

  // ── Level 10: shadow-run clock (10-B) — persists across restarts; see gates/shadow-run.ts ──
  // Level 10.1: `dataDir` is already phase-scoped (config.dbPath itself was
  // scoped in config.ts) — data/shadow, data/paper, data/probe, data/live
  // never share a file. `dataRoot` is the parent of all four, used below
  // ONLY by the live-phase Launch Gate check to read the OTHER phases'
  // evidence (a live-phase process never writes into a sibling phase dir).
  const dataDir = config.dbPath === ':memory:' ? './data' : dirname(config.dbPath)
  const dataRoot = config.dbPath === ':memory:' ? './data' : dirname(dirname(config.dbPath))
  const shadowRun = new ShadowRunTracker(join(dataDir, 'shadow-run.json'), buildFingerprint)

  // Real wiring for the 'rpc_unhealthy' breaker: every endpoint the discovery
  // RpcManager knows about reporting unhealthy at once trips it; the active
  // endpoint reporting healthy again clears it. Runs on the same cadence as
  // RpcManager's own health checks. The same snapshot also feeds the Level
  // 10 shadow-run uptime clock (10-B) — one health signal, two consumers.
  let primaryWasDown = false
  setInterval(() => {
    const snapshot = rpc.healthSnapshot()
    const healthy = snapshot.some((h) => h.healthy)
    if (snapshot.length > 0 && snapshot.every((h) => !h.healthy)) {
      circuitBreaker.trip('rpc_unhealthy', `all ${snapshot.length} discovery RPC endpoint(s) unhealthy`)
    } else if (healthy) {
      circuitBreaker.clear('rpc_unhealthy')
    }
    shadowRun.recordHealthCheck(healthy)

    // RPC_PRIMARY_DOWN — a degraded-but-not-fully-down state distinct from
    // the circuit breaker's ALL_RPC_DOWN: the primary (wss) tier failed over
    // to secondary/emergency, which still works but is worth knowing about.
    // Edge-triggered so this doesn't re-alert every 15s while it stays down.
    const primaryHealthy = snapshot.find((h) => h.tier === 'primary')?.healthy ?? true
    if (!primaryHealthy && !primaryWasDown) {
      void telegramAlerter?.send(
        'RPC_PRIMARY_DOWN',
        'primary RPC endpoint unhealthy — failed over to secondary/emergency',
      )
    }
    primaryWasDown = !primaryHealthy
  }, 15_000).unref?.()

  // ── Level 6/10: execution engine + probe gate (live mode only — paper mode never touches this) ──
  const orderDbPath = config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'orders.db')
  const orderStore = new OrderStore(orderDbPath)
  const probeDbPath = config.dbPath === ':memory:' ? ':memory:' : join(dirname(config.dbPath), 'probes.db')
  const probeStore = new ProbeStore(probeDbPath)
  let executor: Executor | undefined
  let probeGate: ProbeGate | undefined
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

    // Level 10 (10-D): every token's FIRST live buy is gated behind a real
    // $2 probe round trip (see execution/probe-gate.ts) — "新規本注文禁止"
    // enforced structurally in agent.ts's live-buy path, not by strategy discipline.
    const probeEngine = new ProbeEngine({
      executor,
      market: fleet.market,
      probeStore,
      agentId: 'probe',
    })
    probeGate = new ProbeGate(probeEngine, probeStore, 30 * 60_000, telegramAlerter)

    // ── Level 10 (10-F/10-G/10-H): the Live Start Gate — fail-closed, all-or-nothing ──
    // Only evaluated when actually attempting the FULL-SCALE `live` phase —
    // `probe` is itself one of the gate's own prerequisites (10-D) and would
    // be circularly blocked by checking the very gate it's building evidence
    // for. Evaluated from REAL evidence — journal trades, probe/order
    // records, the persisted shadow-run clock, ALL read from their own
    // dedicated phase directories (see the `dataRoot` comment above), never
    // from an operator-typed "yes". A gate that isn't ready refuses to let
    // this process go live at all.
    if (config.runPhase === 'live') {
      const shadowDir = join(dataRoot, 'shadow')
      const paperDir = join(dataRoot, 'paper')
      const probeDir = join(dataRoot, 'probe')
      const evidenceShadowRun = new ShadowRunTracker(join(shadowDir, 'shadow-run.json'))
      const evidenceJournal = new Journal(join(paperDir, 'hood-traders.db'))
      const evidenceProbeStore = new ProbeStore(join(probeDir, 'probes.db'))
      const evidenceOrderStore = new OrderStore(join(probeDir, 'orders.db'))

      const testGatePath = join(dataDir, 'launch-gate-status.json')
      const backupStatusPath = join(dataDir, 'backup-status.json')
      const testStatus = readTestGateStatus(testGatePath)
      const backupStatus = readBackupStatus(backupStatusPath)
      const allowedPriorShas = (process.env.LAUNCH_GATE_ALLOWED_PRIOR_SHAS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const evidence = collectLaunchGateEvidence({
        journal: evidenceJournal,
        orderStore: evidenceOrderStore,
        probeStore: evidenceProbeStore,
        shadowRun: evidenceShadowRun,
        levelTestsPass: testStatus?.levelTestsPass ?? false,
        replayPass: testStatus?.replayPass ?? false,
        securityScanClean: testStatus?.securityScanClean ?? false,
        backupLastRunAt: backupStatus?.lastRunAt ?? null,
        restartRecoveryWired: true, // static fact: recoverPendingOrders is called immediately above, every live boot
        currentFingerprint: buildFingerprint,
        allowedPriorShas,
      })
      evidenceJournal.close()
      evidenceProbeStore.close()
      evidenceOrderStore.close()

      const gate = evaluateLaunchGate(evidence)
      if (!gate.ready) {
        console.error('\n✗ LAUNCH GATE: NOT READY — refusing to start live trading.\n')
        for (const blocker of gate.blockers) console.error(`  - ${blocker}`)
        console.error(
          '\nRun `npm run check-launch-gate` (scripts/check-launch-gate.mjs) and `scripts/backup.sh` to refresh ' +
            'the evidence this gate reads, and let the shadow/paper/probe phases accumulate real elapsed time. ' +
            'This process will exit now rather than sign any live transaction.\n',
        )
        await telegramAlerter?.send('LIVE_GATE_REJECTED', gate.blockers.join('; '))
        process.exit(1)
      }
      console.log(
        `\n✓ LAUNCH GATE: PASS — ${evidence.shadowHoursCompleted.toFixed(1)}h shadow, ` +
          `${evidence.paperClosedTrades} paper trades, ${evidence.probeReconciledCount}/${evidence.probeCyclesCompleted} probes reconciled.\n`,
      )
    }
  }

  const agentIds = ['sniper-1', 'momentum-1', 'premium-1']
  fleet.addAgents([
    {
      id: 'sniper-1',
      strategy: new LaunchSniper(launchSniperParams, discoveryQueue),
      tickIntervalMs: 4000,
      executor,
      circuitBreaker,
      probeGate,
      emergencyMonitor,
      telegramAlerter,
    },
    {
      id: 'momentum-1',
      strategy: new Momentum(momentumParams),
      tickIntervalMs: 15000,
      executor,
      circuitBreaker,
      probeGate,
      emergencyMonitor,
      telegramAlerter,
    },
    {
      id: 'premium-1',
      strategy: new PremiumWatch(premiumWatchParams),
      tickIntervalMs: 30000,
      executor,
      circuitBreaker,
      probeGate,
      emergencyMonitor,
      telegramAlerter,
    },
  ])

  const llm = loadLlmConfig()
  if (llm) {
    fleet.addAgents([
      {
        id: 'llm-1',
        strategy: new LlmStrategist({ llm, minConfidence: loadLlmMinConfidence() }),
        tickIntervalMs: 20000,
        executor,
        circuitBreaker,
        probeGate,
        emergencyMonitor,
        telegramAlerter,
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
    ` dashboard : http://${config.dashboardHost}:${config.dashboardPort}${config.dashboardHost === '0.0.0.0' ? ' (exposed to the network — DASHBOARD_HOST=0.0.0.0)' : ''}`,
    ` kill file : ${config.killFile}`,
    '─'.repeat(60),
  ].join('\n')
  console.log(banner)

  if (config.mode === 'live') {
    console.warn(
      '\n⚠ LIVE MODE — this process will sign and broadcast real transactions with real funds.\n' +
        '  Risk caps are active but are not a guarantee against loss. Ctrl-C or POST /api/kill to halt.\n',
    )
    const account = fleet.market.client.account
    console.log(
      [
        '═'.repeat(60),
        ' SYSTEM READY FOR CONTROLLED $1,000 LIVE TEST',
        '═'.repeat(60),
        ` live start cmd    : HOOD_TRADERS_LIVE=1 LIVE_ACKNOWLEDGED=YES ROBINHOOD_CHAIN_PRIVATE_KEY=*** npm run fleet`,
        ` risk limits       : $${riskProfile.accountLimitUsd} account cap, $${riskProfile.maxPositionUsd}/position, ${riskProfile.maxOpenPositions} max open, ${riskProfile.maxDailyLossPct}% daily loss cap`,
        ` trading wallet    : ${account?.address ?? '(none)'}`,
        ` rpc health        : ${rpc.healthSnapshot().filter((h) => h.healthy).length}/${rpc.healthSnapshot().length} endpoint(s) healthy`,
        ` db backup         : ${readBackupStatus(join(dataDir, 'backup-status.json'))?.lastRunAt ? new Date(readBackupStatus(join(dataDir, 'backup-status.json'))!.lastRunAt).toISOString() : 'never run — see scripts/backup.sh'}`,
        ` kill switch       : file=${config.killFile} (touch this file, or POST /api/kill, to halt immediately)`,
        '═'.repeat(60),
      ].join('\n'),
    )
  }

  void telegramAlerter?.send(
    'BOT_START',
    `hood-traders starting — mode=${config.mode} network=${config.network}`,
  )
  await fleet.start()

  // Level 10.1: read-only Telegram remote control (/status, /positions,
  // /pause — never /resume, never a buy/sell). Only active when Telegram is
  // configured at all.
  const telegramBot = telegramConfig
    ? new TelegramBot(
        { botToken: telegramConfig.botToken, onError: (e) => console.warn(`telegram-bot: ${e.message}`) },
        {
          adminChatId: telegramConfig.chatId,
          fleetSummary: () => fleet.summary(),
          agentStatuses: () => fleet.agentStatuses(),
          pause: () => circuitBreaker.trip('manual_pause', 'paused via Telegram /pause command'),
        },
      )
    : undefined
  telegramBot?.start()

  const server = createDashboardServer(fleet, DASHBOARD_STATIC_ROOT)
  server.listen(config.dashboardPort, config.dashboardHost, () => {
    console.log(`dashboard listening on ${config.dashboardHost}:${config.dashboardPort}`)
  })

  const shutdown = () => {
    console.log('\nshutting down — stopping agents, closing journal…')
    void telegramAlerter?.send('BOT_STOP', 'hood-traders shutting down')
    telegramBot?.stop()
    launchDetector.stop()
    walletTracker.stop()
    rpc.stop()
    discoveryQueue.close()
    walletStore.close()
    orderStore.close()
    probeStore.close()
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
