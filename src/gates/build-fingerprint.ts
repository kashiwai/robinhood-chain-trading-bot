import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

/** The spec's Level 10.1 evidence fingerprint — attached to everything the Launch Gate reads. */
export interface BuildFingerprint {
  gitCommitSha: string
  /** Informational only (when this fingerprint was computed) — NOT part of the validity comparison, since two identical builds started at different times are still the same build. */
  buildTimestamp: number
  configHash: string
  strategyVersion: string
  databaseSchemaVersion: string
  chainId: number
  rpcProviderConfigurationHash: string
}

export interface BuildFingerprintInputs {
  /** JSON-serializable subset of config/risk-profile that actually affects trading logic (position caps, exit tiers, stock-token eligibility, etc.) — NOT operational settings like dashboard port or DB path. */
  tradingConfig: unknown
  /** JSON-serializable strategy parameters actually constructed (LaunchSniper/Momentum/PremiumWatch params) — changing a strategy's numbers changes this even with no code diff at all. */
  strategyParams: unknown
  chainId: number
  rpcConfig: { rpcUrl: string | undefined; wsRpcUrl: string | undefined; network: string }
  databaseSchemaVersion: string
  /** Override for testing — defaults to `GIT_COMMIT_SHA` env or a real `git rev-parse HEAD`. */
  gitCommitSha?: string
}

function sha256(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

/** `'unknown'` when neither a real git repo nor GIT_COMMIT_SHA is available (e.g. a bundled Docker image with no `.git`) — never fabricated. */
export function resolveGitCommitSha(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GIT_COMMIT_SHA) return env.GIT_COMMIT_SHA
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

export function computeBuildFingerprint(inputs: BuildFingerprintInputs): BuildFingerprint {
  return {
    gitCommitSha: inputs.gitCommitSha ?? resolveGitCommitSha(),
    buildTimestamp: Date.now(),
    configHash: sha256(inputs.tradingConfig),
    strategyVersion: sha256(inputs.strategyParams),
    databaseSchemaVersion: inputs.databaseSchemaVersion,
    chainId: inputs.chainId,
    rpcProviderConfigurationHash: sha256(inputs.rpcConfig),
  }
}

export interface FingerprintMatchResult {
  matches: boolean
  mismatchedFields: string[]
}

/**
 * Strict by default: every field must match, including `gitCommitSha` — any
 * code change at all invalidates prior evidence unless the operator
 * explicitly vouches for a specific prior SHA via `allowedPriorShas` (e.g. a
 * reviewed, doc-only commit — `LAUNCH_GATE_ALLOWED_PRIOR_SHAS` in main.ts).
 * That allowance ONLY excuses the SHA field — `configHash`/`strategyVersion`/
 * `databaseSchemaVersion`/`chainId`/`rpcProviderConfigurationHash` are always
 * still compared, so a mislabeled "docs-only" commit that actually touched
 * trading logic is still caught and rejected.
 */
export function evaluateFingerprintMatch(
  recorded: BuildFingerprint,
  current: BuildFingerprint,
  allowedPriorShas: readonly string[] = [],
): FingerprintMatchResult {
  const mismatchedFields: string[] = []
  if (recorded.gitCommitSha !== current.gitCommitSha && !allowedPriorShas.includes(recorded.gitCommitSha)) {
    mismatchedFields.push('gitCommitSha')
  }
  if (recorded.configHash !== current.configHash) mismatchedFields.push('configHash')
  if (recorded.strategyVersion !== current.strategyVersion) mismatchedFields.push('strategyVersion')
  if (recorded.databaseSchemaVersion !== current.databaseSchemaVersion) {
    mismatchedFields.push('databaseSchemaVersion')
  }
  if (recorded.chainId !== current.chainId) mismatchedFields.push('chainId')
  if (recorded.rpcProviderConfigurationHash !== current.rpcProviderConfigurationHash) {
    mismatchedFields.push('rpcProviderConfigurationHash')
  }
  return { matches: mismatchedFields.length === 0, mismatchedFields }
}
