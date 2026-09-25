import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Written by `scripts/check-launch-gate.mjs` after actually running the test/replay/secret-scan checks. */
export interface TestGateStatus {
  levelTestsPass: boolean
  replayPass: boolean
  securityScanClean: boolean
  checkedAt: number
}

/** Written by `scripts/backup.sh` after actually copying the SQLite stores out. */
export interface BackupStatus {
  lastRunAt: number
}

/**
 * Missing or unreadable -> `null`, never a thrown error and never a
 * fabricated "pass". Both `main.ts` (the live-mode launch gate) and
 * `scripts/check-launch-gate.mjs` (which writes {@link TestGateStatus}) treat
 * "no status file yet" identically to "checks have not been run" — fail
 * closed, not "assume clean".
 */
export function readTestGateStatus(path: string): TestGateStatus | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TestGateStatus
  } catch {
    return null
  }
}

export function writeTestGateStatus(path: string, status: TestGateStatus): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(status, null, 2))
}

export function readBackupStatus(path: string): BackupStatus | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BackupStatus
  } catch {
    return null
  }
}

export function writeBackupStatus(path: string, status: BackupStatus): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(status, null, 2))
}
