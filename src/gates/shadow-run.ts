import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ShadowRunState {
  startedAt: number
  healthChecks: number
  healthyChecks: number
  lastCheckAt: number | null
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

  constructor(private readonly statePath: string) {
    this.state = this.load()
  }

  private load(): ShadowRunState {
    if (existsSync(this.statePath)) {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as ShadowRunState
    }
    return { startedAt: Date.now(), healthChecks: 0, healthyChecks: 0, lastCheckAt: null }
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
}
