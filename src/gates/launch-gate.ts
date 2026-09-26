import type { FingerprintMatchResult } from './build-fingerprint.js'

export interface LaunchGateEvidence {
  /** `npm test` (all unit suites, which cover Levels 1-9's acceptance criteria) exits clean. */
  levelTestsPass: boolean
  /** `npm run test:replay` — Level 2's 1000-event / Level 9's 1000-trade replay suites — exits clean. */
  replayPass: boolean
  /** Real elapsed hours the shadow run (10-B) has been continuously up. */
  shadowHoursCompleted: number
  /** Fraction of the shadow window the discovery/RPC path actually reported healthy. */
  shadowUptimePct: number
  /** Real closed (buy+sell matched) PAPER-mode trades in the journal (10-C). */
  paperClosedTrades: number
  /** Real probe cycles (10-D) that reached a terminal state. */
  probeCyclesCompleted: number
  /** Of those, how many reconciled cleanly (buy AND sell both RECONCILED, no mismatch). */
  probeReconciledCount: number
  /** Any probe with an accounting mismatch (actual fill inexplicable from the ledger) or an unrecoverable sell failure. */
  probeMismatchOrUnrecoverableCount: number
  /** gitleaks + `npm audit --omit=dev` both clean (Level 1). */
  securityScanClean: boolean
  /** A backup has actually been run, and recently. */
  backupLastRunAt: number | null
  /** recoverPendingOrders (Level 6) is wired into main.ts's live-mode startup path. */
  restartRecoveryWired: boolean
  /**
   * Level 10.1: the shadow/paper/probe evidence's pinned build fingerprint
   * compared against the CURRENT build attempting to go live (see
   * gates/build-fingerprint.ts). `null` means no fingerprint was ever
   * recorded (e.g. a shadow run that predates Level 10.1, or one that never
   * started) — treated as a failure, not a free pass, same as any other
   * missing evidence.
   */
  buildFingerprintMatch: FingerprintMatchResult | null
}

export interface LaunchGateThresholds {
  minShadowHours: number
  minShadowUptimePct: number
  minPaperTrades: number
  minProbeCycles: number
  maxBackupAgeMs: number
}

export const DEFAULT_LAUNCH_GATE_THRESHOLDS: LaunchGateThresholds = {
  minShadowHours: 72,
  minShadowUptimePct: 0.95,
  minPaperTrades: 200,
  minProbeCycles: 20,
  maxBackupAgeMs: 24 * 60 * 60 * 1000,
}

export interface LaunchGateResult {
  ready: boolean
  flags: Record<string, boolean>
  blockers: string[]
}

/**
 * The spec's Live Start Gate, evaluated from REAL evidence — not operator-
 * set booleans. `LEVEL_1_PASS`..`LEVEL_9_PASS` collapse into one
 * `levelTestsPass` flag here: this codebase's tests aren't segmented into
 * one suite per spec level, so "every level's acceptance criteria still
 * hold" is, pragmatically, "the whole suite is green" — noted here rather
 * than pretending nine independently-tracked flags exist when they don't.
 *
 * `ready` is false unless EVERY flag is true — there is no partial-credit
 * path, and no flag here can be forced true by anything other than the
 * real condition it names actually being met.
 */
export function evaluateLaunchGate(
  evidence: LaunchGateEvidence,
  thresholds: LaunchGateThresholds = DEFAULT_LAUNCH_GATE_THRESHOLDS,
  now = Date.now(),
): LaunchGateResult {
  const flags: Record<string, boolean> = {
    LEVEL_1_9_PASS: evidence.levelTestsPass,
    REPLAY_PASS: evidence.replayPass,
    SHADOW_PASS:
      evidence.shadowHoursCompleted >= thresholds.minShadowHours &&
      evidence.shadowUptimePct >= thresholds.minShadowUptimePct,
    PAPER_PASS: evidence.paperClosedTrades >= thresholds.minPaperTrades,
    PROBE_PASS:
      evidence.probeCyclesCompleted >= thresholds.minProbeCycles &&
      evidence.probeReconciledCount === evidence.probeCyclesCompleted &&
      evidence.probeMismatchOrUnrecoverableCount === 0,
    SECURITY_PASS: evidence.securityScanClean,
    BACKUP_PASS:
      evidence.backupLastRunAt !== null && now - evidence.backupLastRunAt <= thresholds.maxBackupAgeMs,
    RECOVERY_PASS: evidence.restartRecoveryWired,
    BUILD_FINGERPRINT_PASS: evidence.buildFingerprintMatch?.matches === true,
  }

  const blockers = Object.entries(flags)
    .filter(([, ok]) => !ok)
    .map(([name]) => describeBlocker(name, evidence, thresholds))

  return { ready: blockers.length === 0, flags, blockers }
}

function describeBlocker(flag: string, e: LaunchGateEvidence, t: LaunchGateThresholds): string {
  switch (flag) {
    case 'LEVEL_1_9_PASS':
      return 'unit test suite is not passing'
    case 'REPLAY_PASS':
      return 'replay test suite is not passing'
    case 'SHADOW_PASS':
      return `shadow run: ${e.shadowHoursCompleted.toFixed(1)}h / ${t.minShadowHours}h at ${(e.shadowUptimePct * 100).toFixed(1)}% uptime (need >=${(t.minShadowUptimePct * 100).toFixed(0)}%)`
    case 'PAPER_PASS':
      return `paper trades: ${e.paperClosedTrades} / ${t.minPaperTrades} closed`
    case 'PROBE_PASS':
      return `probes: ${e.probeCyclesCompleted}/${t.minProbeCycles} cycles, ${e.probeReconciledCount} reconciled, ${e.probeMismatchOrUnrecoverableCount} mismatch/unrecoverable`
    case 'SECURITY_PASS':
      return 'security scan (secrets/dependency audit) is not clean'
    case 'BACKUP_PASS':
      return e.backupLastRunAt === null ? 'no backup has ever been run' : 'backup is stale'
    case 'RECOVERY_PASS':
      return 'restart recovery is not wired into the live-mode startup path'
    case 'BUILD_FINGERPRINT_PASS':
      return e.buildFingerprintMatch === null
        ? 'no build fingerprint was ever recorded for the accumulated shadow/paper/probe evidence'
        : `evidence was recorded under a different build — mismatched fields: ${e.buildFingerprintMatch.mismatchedFields.join(', ')}`
    default:
      return flag
  }
}
