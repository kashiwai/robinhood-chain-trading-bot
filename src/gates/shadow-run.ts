import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BuildFingerprint } from './build-fingerprint.js'

export interface ShadowRunState {
  startedAt: number
  healthChecks: number
  healthyChecks: number
  lastCheckAt: number | null
  /** Level 10.1: captured once, on first use — see `recordedFingerprint()`'s doc comment. */
  buildFingerprint: BuildFingerprint | null
}

/**
 * Tracks Level 10's 10-B shadow run (>=72 real hours, no real money, discovery
 * + paper trading running continuously) across process restarts — a JSON
 * file, not a database table, because this is exactly one small piece of
 * state that needs to survive for days regardless of how many times the
 * process itself restarts in that window. `startedAt` is set once, on first
 * use, and never reset by this class — restarting the PROCESS does not
 * restart the CLOCK. Only deleting the state file does (an explicit,
 * deliberate operator action — see scripts/start-shadow.sh).
 */
export class ShadowRunTracker {
  private state: ShadowRunState

  constructor(
    private readonly statePath: string,
    private readonly currentFingerprint?: BuildFingerprint,
  ) {
    const existedBefore = existsSync(statePath)
    this.state = this.load()
    // Persist immediately on first-ever construction — `startedAt` must be
    // durable the instant it's chosen, not only once the first health check
    // happens to fire. Without this, two constructions in quick succession
    // (no file yet either time) would each independently compute their own
    // `Date.now()` instead of the second one reading the first one's value.
    if (!existedBefore) this.save()
    // Captured once, whenever this tracker first sees a real fingerprint and
    // hasn't recorded one yet — NOT re-captured on every boot, since that
    // would defeat the whole point (the fingerprint is meant to answer "is
    // this the SAME build that has been accumulating evidence," which only
    // works if it's pinned at the start).
    if (this.currentFingerprint && this.state.buildFingerprint === null) {
      this.state.buildFingerprint = this.currentFingerprint
      this.save()
    }
  }

  private load(): ShadowRunState {
    if (existsSync(this.statePath)) {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<ShadowRunState>
      return {
        startedAt: parsed.startedAt ?? Date.now(),
        healthChecks: parsed.healthChecks ?? 0,
        healthyChecks: parsed.healthyChecks ?? 0,
        lastCheckAt: parsed.lastCheckAt ?? null,
        buildFingerprint: parsed.buildFingerprint ?? null,
      }
    }
    return {
      startedAt: Date.now(),
      healthChecks: 0,
      healthyChecks: 0,
      lastCheckAt: null,
      buildFingerprint: null,
    }
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true })
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2))
  }

  recordHealthCheck(healthy: boolean, now = Date.now()): void {
    this.state.healthChecks += 1
    if (healthy) this.state.healthyChecks += 1
    this.state.lastCheckAt = now
    this.save()
  }

  hoursCompleted(now = Date.now()): number {
    return (now - this.state.startedAt) / (60 * 60 * 1000)
  }

  uptimePct(): number {
    return this.state.healthChecks > 0 ? this.state.healthyChecks / this.state.healthChecks : 0
  }

  startedAt(): number {
    return this.state.startedAt
  }

  /** The build fingerprint pinned when this shadow run first started accumulating evidence — `null` if the tracker was constructed without one (e.g. an older on-disk state file, or a caller that hasn't adopted Level 10.1 fingerprinting). */
  recordedFingerprint(): BuildFingerprint | null {
    return this.state.buildFingerprint
  }
}
