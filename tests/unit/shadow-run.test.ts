import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShadowRunTracker } from '../../src/gates/shadow-run.js'
import { computeBuildFingerprint, type BuildFingerprint } from '../../src/gates/build-fingerprint.js'

function fingerprint(
  overrides: Partial<Parameters<typeof computeBuildFingerprint>[0]> = {},
): BuildFingerprint {
  return computeBuildFingerprint({
    tradingConfig: { x: 1 },
    strategyParams: { y: 1 },
    chainId: 4663,
    rpcConfig: { rpcUrl: undefined, wsRpcUrl: undefined, network: 'mainnet' },
    databaseSchemaVersion: '1',
    gitCommitSha: 'sha1',
    ...overrides,
  })
}

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('ShadowRunTracker', () => {
  it('starts the clock on first use', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const statePath = join(dir, 'shadow-state.json')
    const now = 1_000_000
    const tracker = new ShadowRunTracker(statePath)
    // hoursCompleted right away should be ~0 relative to real Date.now() (started at construction time)
    expect(tracker.hoursCompleted(now)).toBeLessThanOrEqual(0) // now (fixed past ts) is before the real construction time
  })

  it('the clock SURVIVES a process restart — a new tracker instance reads the same start time from disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const statePath = join(dir, 'shadow-state.json')
    const first = new ShadowRunTracker(statePath)
    const startedAt = first.startedAt()

    const second = new ShadowRunTracker(statePath) // simulates a restart — reads the persisted file
    expect(second.startedAt()).toBe(startedAt)
  })

  it('hoursCompleted reflects real elapsed time since the persisted start', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const statePath = join(dir, 'shadow-state.json')
    const tracker = new ShadowRunTracker(statePath)
    const startedAt = tracker.startedAt()
    const threeDaysLater = startedAt + 72 * 60 * 60 * 1000
    expect(tracker.hoursCompleted(threeDaysLater)).toBeCloseTo(72, 6)
  })

  it('uptimePct is 0 with no health checks yet, not NaN', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const tracker = new ShadowRunTracker(join(dir, 'shadow-state.json'))
    expect(tracker.uptimePct()).toBe(0)
  })

  it('uptimePct reflects the real ratio of healthy checks, and persists across restarts', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const statePath = join(dir, 'shadow-state.json')
    const tracker = new ShadowRunTracker(statePath)
    tracker.recordHealthCheck(true)
    tracker.recordHealthCheck(true)
    tracker.recordHealthCheck(false)
    tracker.recordHealthCheck(true)
    expect(tracker.uptimePct()).toBeCloseTo(0.75, 6)

    const restarted = new ShadowRunTracker(statePath)
    expect(restarted.uptimePct()).toBeCloseTo(0.75, 6) // not reset by the "restart"
  })

  it('recordedFingerprint is null when no fingerprint was ever supplied', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const tracker = new ShadowRunTracker(join(dir, 'shadow-state.json'))
    expect(tracker.recordedFingerprint()).toBeNull()
  })

  it('a fingerprint supplied on first use is pinned and persists across restarts', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const statePath = join(dir, 'shadow-state.json')
    const first = new ShadowRunTracker(statePath, fingerprint({ gitCommitSha: 'sha1' }))
    expect(first.recordedFingerprint()?.gitCommitSha).toBe('sha1')

    const restarted = new ShadowRunTracker(statePath) // no fingerprint passed this time — simulates a normal restart
    expect(restarted.recordedFingerprint()?.gitCommitSha).toBe('sha1') // still the ORIGINAL, not cleared
  })

  it('a DIFFERENT fingerprint on a later boot does NOT overwrite the originally-pinned one', () => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const statePath = join(dir, 'shadow-state.json')
    new ShadowRunTracker(statePath, fingerprint({ gitCommitSha: 'sha1' }))
    const second = new ShadowRunTracker(statePath, fingerprint({ gitCommitSha: 'sha2' }))
    expect(second.recordedFingerprint()?.gitCommitSha).toBe('sha1') // the pinned baseline, not the new boot's
  })
})
