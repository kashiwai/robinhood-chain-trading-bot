import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readTestGateStatus,
  writeTestGateStatus,
  readBackupStatus,
  writeBackupStatus,
} from '../../src/gates/launch-gate-status.js'

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('launch-gate-status — fail-closed status file read/write', () => {
  it('a missing test-gate status file reads as null, not a fabricated pass', () => {
    dir = mkdtempSync(join(tmpdir(), 'lgs-'))
    expect(readTestGateStatus(join(dir, 'nope.json'))).toBeNull()
  })

  it('round-trips a written test-gate status', () => {
    dir = mkdtempSync(join(tmpdir(), 'lgs-'))
    const path = join(dir, 'sub', 'launch-gate-status.json')
    writeTestGateStatus(path, {
      levelTestsPass: true,
      replayPass: true,
      securityScanClean: false,
      checkedAt: 12345,
    })
    expect(readTestGateStatus(path)).toEqual({
      levelTestsPass: true,
      replayPass: true,
      securityScanClean: false,
      checkedAt: 12345,
    })
  })

  it('a corrupted test-gate status file reads as null rather than throwing', () => {
    dir = mkdtempSync(join(tmpdir(), 'lgs-'))
    const path = join(dir, 'bad.json')
    writeTestGateStatus(path, {
      levelTestsPass: true,
      replayPass: true,
      securityScanClean: true,
      checkedAt: 1,
    })
    // corrupt it after the fact
    writeFileSync(path, '{not valid json')
    expect(readTestGateStatus(path)).toBeNull()
  })

  it('a missing backup status file reads as null', () => {
    dir = mkdtempSync(join(tmpdir(), 'lgs-'))
    expect(readBackupStatus(join(dir, 'nope.json'))).toBeNull()
  })

  it('round-trips a written backup status', () => {
    dir = mkdtempSync(join(tmpdir(), 'lgs-'))
    const path = join(dir, 'backup-status.json')
    writeBackupStatus(path, { lastRunAt: 99999 })
    expect(readBackupStatus(path)).toEqual({ lastRunAt: 99999 })
  })
})
