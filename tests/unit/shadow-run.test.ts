import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShadowRunTracker } from '../../src/gates/shadow-run.js'

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
})
