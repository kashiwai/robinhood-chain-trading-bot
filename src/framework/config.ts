import { dirname, join, basename } from 'node:path'
import type { HoodNetwork } from 'hoodchain'
import type { Mode, RiskLimits } from './types.js'
import type { LlmClientConfig, LlmProvider } from './llm.js'

/**
 * Level 10.1: which validation phase this process is running as, for DATA
 * SEPARATION purposes ONLY — see main.ts's `dataDir` derivation. Never
 * affects trading logic, risk limits, or the build fingerprint's
 * `configHash`. `shadow` and `paper` can run as two fully independent,
 * simultaneous processes without sharing a DB, Journal, or state cursor;
 * `probe` and `live` are both real-money `mode: 'live'` runs that differ
 * only in risk caps and which directory (and therefore which Launch Gate
 * evidence bucket) they write to.
 */
export type RunPhase = 'shadow' | 'paper' | 'probe' | 'live'

/** Fleet-wide configuration resolved from the environment. */
export interface FleetConfig {
  network: HoodNetwork
  rpcUrl: string | undefined
  /** Optional wss:// endpoint — primary tier for the discovery RpcManager (true push, no poll latency). */
  wsRpcUrl: string | undefined
  mode: Mode
  runPhase: RunPhase
  /** Set true only when HOOD_TRADERS_LIVE=1 AND a key is present. */
  hasWallet: boolean
  /** The spec's `LIVE_ACKNOWLEDGED=YES` — a separate, explicit "I understand this risks real money" flag, distinct from simply enabling live mode. */
  liveAcknowledged: boolean
  privateKey: `0x${string}` | undefined
  stockTokenEligible: boolean
  fleetMaxDailySpendUsdg: number
  dashboardPort: number
  /** Bind address for the dashboard/kill-switch HTTP server. Defaults to loopback-only — set DASHBOARD_HOST=0.0.0.0 explicitly (e.g. inside Docker) to expose it. */
  dashboardHost: string
  killFile: string
  /** Path to the SQLite journal. */
  dbPath: string
  defaultLimits: RiskLimits
}

/**
 * Level 10.1 data separation: inserts the run phase as a subdirectory
 * between the configured base directory and the filename — e.g.
 * `./data/hood-traders.db` + phase `shadow` -> `./data/shadow/hood-traders.db`.
 * Every other per-store DB path in main.ts (discovery/wallets/orders/probes)
 * derives from `dirname(config.dbPath)`, so scoping it here at the source
 * gives every store phase separation for free, with no further plumbing.
 * `:memory:` (the test/in-memory sentinel) is passed through unchanged —
 * there is no real directory to scope.
 */
function phaseScopedPath(basePath: string, runPhase: RunPhase): string {
  if (basePath === ':memory:') return basePath
  return join(dirname(basePath), runPhase, basename(basePath))
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env ${name}="${raw}" is not a non-negative number`)
  }
  return n
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

/**
 * Resolve fleet configuration from the environment.
 *
 * Live mode is deliberately hard to enable by accident: it requires ALL of
 * `HOOD_TRADERS_LIVE=1`, a `ROBINHOOD_CHAIN_PRIVATE_KEY`, AND
 * `LIVE_ACKNOWLEDGED=YES` (exact string, case-sensitive — the spec's own
 * explicit-consent flag, kept separate from "enable live" so a script that
 * flips HOOD_TRADERS_LIVE=1 for a paper-mode reason can never silently arm
 * real money). Missing any one of the three falls back to paper mode rather
 * than erroring, so a mis-set flag can never silently spend real funds.
 */
export function loadFleetConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
  const network = (env.HOOD_NETWORK === 'testnet' ? 'testnet' : 'mainnet') as HoodNetwork
  const wantLive = bool(env, 'HOOD_TRADERS_LIVE', false)
  const privateKey = env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined
  const hasKey = typeof privateKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(privateKey)
  const liveAcknowledged = env.LIVE_ACKNOWLEDGED === 'YES'
  const mode: Mode = wantLive && hasKey && liveAcknowledged ? 'live' : 'paper'
  const runPhaseRaw = env.HOOD_RUN_PHASE
  const validRunPhases: readonly RunPhase[] = ['shadow', 'paper', 'probe', 'live']
  if (runPhaseRaw && !validRunPhases.includes(runPhaseRaw as RunPhase)) {
    throw new Error(
      `hood-traders config.ts: HOOD_RUN_PHASE="${runPhaseRaw}" is not one of ${validRunPhases.join(', ')}`,
    )
  }
  const runPhase: RunPhase = (runPhaseRaw as RunPhase | undefined) ?? (mode === 'live' ? 'live' : 'paper')
  const livePhases: readonly RunPhase[] = ['probe', 'live']
  if (livePhases.includes(runPhase) !== (mode === 'live')) {
    throw new Error(
      `hood-traders config.ts: HOOD_RUN_PHASE="${runPhase}" requires mode='live' (HOOD_TRADERS_LIVE=1 + a valid key + LIVE_ACKNOWLEDGED=YES) ` +
        `and vice versa — got mode='${mode}'. This is checked explicitly rather than silently running the wrong phase in the wrong mode.`,
    )
  }

  return {
    network,
    rpcUrl: env.HOOD_RPC_URL || undefined,
    wsRpcUrl: env.HOOD_WS_RPC_URL || undefined,
    mode,
    runPhase,
    hasWallet: hasKey,
    liveAcknowledged,
    privateKey: hasKey ? privateKey : undefined,
    stockTokenEligible: bool(env, 'HOOD_STOCK_TOKEN_ELIGIBLE', false),
    fleetMaxDailySpendUsdg: num(env, 'FLEET_MAX_DAILY_SPEND_USDG', 250),
    dashboardPort: num(env, 'DASHBOARD_PORT', 4670),
    dashboardHost: env.DASHBOARD_HOST || '127.0.0.1',
    killFile: env.KILL_FILE || './KILL',
    dbPath: phaseScopedPath(env.HOOD_TRADERS_DB || './data/hood-traders.db', runPhase),
    defaultLimits: {
      maxPositionUsdg: num(env, 'AGENT_MAX_POSITION_USDG', 50),
      maxDailySpendUsdg: num(env, 'AGENT_MAX_DAILY_SPEND_USDG', 100),
      maxSlippageBps: num(env, 'AGENT_MAX_SLIPPAGE_BPS', 100),
      cooldownSeconds: num(env, 'AGENT_COOLDOWN_SECONDS', 60),
    },
  }
}

const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai', 'groq', 'openrouter']

/**
 * Resolve LLM config for {@link LlmStrategist} from the environment. Returns
 * `null` when `HOOD_LLM_PROVIDER` or `HOOD_LLM_API_KEY` is unset — the
 * strategy is optional and simply isn't added to the fleet in that case (see
 * main.ts). Throws only when `HOOD_LLM_PROVIDER` is set to an unrecognized
 * value, since that is very likely a typo the operator would want to know
 * about immediately rather than silently running without the strategy.
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmClientConfig | null {
  const provider = env.HOOD_LLM_PROVIDER
  const apiKey = env.HOOD_LLM_API_KEY
  if (!provider && !apiKey) return null
  if (!provider || !apiKey) {
    throw new Error(
      'hood-traders config.ts: HOOD_LLM_PROVIDER and HOOD_LLM_API_KEY must both be set to enable llm-strategist (or both left unset to disable it).',
    )
  }
  if (!LLM_PROVIDERS.includes(provider as LlmProvider)) {
    throw new Error(
      `hood-traders config.ts: HOOD_LLM_PROVIDER="${provider}" is not one of ${LLM_PROVIDERS.join(', ')}`,
    )
  }
  return {
    provider: provider as LlmProvider,
    apiKey,
    model: env.HOOD_LLM_MODEL || undefined,
    timeoutMs: num(env, 'HOOD_LLM_TIMEOUT_MS', 9000),
  }
}

/** Minimum LLM confidence required to convert a `buy` verdict into a trade. */
export function loadLlmMinConfidence(env: NodeJS.ProcessEnv = process.env): number {
  return num(env, 'HOOD_LLM_MIN_CONFIDENCE', 0.6)
}

export interface TelegramConfig {
  botToken: string
  /** The spec's fixed, explicitly-configured admin chat — never learned at runtime. */
  chatId: string
}

/**
 * Level 10.1 critical alerting + read-only remote control (see
 * alerts/telegram.ts). Returns `null` when unset — Telegram is entirely
 * optional. Same "both or neither" validation as `loadLlmConfig`, since a
 * bot token without a fixed admin chat (or vice versa) is a misconfiguration
 * an operator would want to know about immediately, not a silently-degraded
 * feature.
 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (!botToken && !chatId) return null
  if (!botToken || !chatId) {
    throw new Error(
      'hood-traders config.ts: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set to enable Telegram alerts (or both left unset to disable it).',
    )
  }
  return { botToken, chatId }
}
