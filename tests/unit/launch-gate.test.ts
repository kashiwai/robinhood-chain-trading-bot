import { describe, expect, it } from 'vitest'
import {
  evaluateLaunchGate,
  DEFAULT_LAUNCH_GATE_THRESHOLDS,
  type LaunchGateEvidence,
} from '../../src/gates/launch-gate.js'

function readyEvidence(overrides: Partial<LaunchGateEvidence> = {}): LaunchGateEvidence {
  return {
    levelTestsPass: true,
    replayPass: true,
    shadowHoursCompleted: 80,
    shadowUptimePct: 0.99,
    paperClosedTrades: 250,
    probeCyclesCompleted: 20,
    probeReconciledCount: 20,
    probeMismatchOrUnrecoverableCount: 0,
    securityScanClean: true,
    backupLastRunAt: Date.now() - 60_000,
    restartRecoveryWired: true,
    buildFingerprintMatch: { matches: true, mismatchedFields: [] },
    ...overrides,
  }
}

describe("evaluateLaunchGate — the spec's all-or-nothing Live Start Gate", () => {
  it('every real condition met -> ready, zero blockers', () => {
    const result = evaluateLaunchGate(readyEvidence())
    expect(result.ready).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(Object.values(result.flags).every(Boolean)).toBe(true)
  })

  it('failing unit tests alone blocks launch, regardless of everything else being perfect', () => {
    const result = evaluateLaunchGate(readyEvidence({ levelTestsPass: false }))
    expect(result.ready).toBe(false)
    expect(result.flags.LEVEL_1_9_PASS).toBe(false)
    expect(result.blockers.some((b) => b.includes('unit test'))).toBe(true)
  })

  it('shadow run under 72 hours blocks, even at 71.9', () => {
    const result = evaluateLaunchGate(readyEvidence({ shadowHoursCompleted: 71.9 }))
    expect(result.ready).toBe(false)
    expect(result.flags.SHADOW_PASS).toBe(false)
  })

  it('72+ hours but low uptime still blocks — duration alone is not enough', () => {
    const result = evaluateLaunchGate(readyEvidence({ shadowHoursCompleted: 100, shadowUptimePct: 0.5 }))
    expect(result.flags.SHADOW_PASS).toBe(false)
  })

  it('199 paper trades blocks; 200 passes — an exact boundary', () => {
    expect(evaluateLaunchGate(readyEvidence({ paperClosedTrades: 199 })).flags.PAPER_PASS).toBe(false)
    expect(evaluateLaunchGate(readyEvidence({ paperClosedTrades: 200 })).flags.PAPER_PASS).toBe(true)
  })

  it('20/20 probe reconciliation required — even ONE unreconciled or mismatched probe blocks', () => {
    const partiallyReconciled = evaluateLaunchGate(readyEvidence({ probeReconciledCount: 19 }))
    expect(partiallyReconciled.flags.PROBE_PASS).toBe(false)

    const oneMismatch = evaluateLaunchGate(readyEvidence({ probeMismatchOrUnrecoverableCount: 1 }))
    expect(oneMismatch.flags.PROBE_PASS).toBe(false)
  })

  it('fewer than 20 probe cycles blocks even with perfect reconciliation so far', () => {
    const result = evaluateLaunchGate(
      readyEvidence({
        probeCyclesCompleted: 10,
        probeReconciledCount: 10,
        probeMismatchOrUnrecoverableCount: 0,
      }),
    )
    expect(result.flags.PROBE_PASS).toBe(false)
  })

  it('a stale backup (older than maxBackupAgeMs) blocks', () => {
    const result = evaluateLaunchGate(readyEvidence({ backupLastRunAt: Date.now() - 48 * 60 * 60 * 1000 }))
    expect(result.flags.BACKUP_PASS).toBe(false)
  })

  it('no backup ever run blocks', () => {
    const result = evaluateLaunchGate(readyEvidence({ backupLastRunAt: null }))
    expect(result.flags.BACKUP_PASS).toBe(false)
  })

  it('security scan not clean blocks', () => {
    expect(evaluateLaunchGate(readyEvidence({ securityScanClean: false })).flags.SECURITY_PASS).toBe(false)
  })

  it('restart recovery not wired blocks', () => {
    expect(evaluateLaunchGate(readyEvidence({ restartRecoveryWired: false })).flags.RECOVERY_PASS).toBe(false)
  })

  it('multiple simultaneous failures are ALL reported as blockers, not just the first', () => {
    const result = evaluateLaunchGate(
      readyEvidence({ levelTestsPass: false, paperClosedTrades: 0, securityScanClean: false }),
    )
    expect(result.blockers.length).toBeGreaterThanOrEqual(3)
  })

  it('a null buildFingerprintMatch (no fingerprint ever recorded) blocks launch', () => {
    const result = evaluateLaunchGate(readyEvidence({ buildFingerprintMatch: null }))
    expect(result.ready).toBe(false)
    expect(result.flags.BUILD_FINGERPRINT_PASS).toBe(false)
    expect(result.blockers.some((b) => b.includes('no build fingerprint'))).toBe(true)
  })

  it('a mismatched buildFingerprintMatch blocks launch and names the mismatched fields', () => {
    const result = evaluateLaunchGate(
      readyEvidence({ buildFingerprintMatch: { matches: false, mismatchedFields: ['configHash'] } }),
    )
    expect(result.ready).toBe(false)
    expect(result.flags.BUILD_FINGERPRINT_PASS).toBe(false)
    expect(result.blockers.some((b) => b.includes('configHash'))).toBe(true)
  })

  it('custom (stricter) thresholds are respected', () => {
    const strict = { ...DEFAULT_LAUNCH_GATE_THRESHOLDS, minPaperTrades: 500 }
    const result = evaluateLaunchGate(readyEvidence({ paperClosedTrades: 250 }), strict)
    expect(result.flags.PAPER_PASS).toBe(false)
  })
})
