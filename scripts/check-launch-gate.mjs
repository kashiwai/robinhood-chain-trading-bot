#!/usr/bin/env node
// Runs the real checks the Level 10 Launch Gate reads before allowing live
// trading to start (see src/gates/launch-gate.ts, src/main.ts): the unit
// suite, the replay suite, and a secret scan. Writes the outcome to
// data/launch-gate-status.json — main.ts refuses to boot into live mode
// unless that file says every one of these actually passed, recently.
//
// This script does NOT run the dependency audit as part of the boolean
// (a known, unpatched transitive advisory shouldn't be able to silently
// block live trading forever) but DOES print its result for the operator to
// read — see the printed summary at the end.
//
// Usage: node scripts/check-launch-gate.mjs [--db-dir ./data]

import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const dbDir = arg('db-dir', './data')
const statusPath = join(dbDir, 'launch-gate-status.json')

function run(label, cmd) {
  process.stdout.write(`→ ${label}... `)
  try {
    execSync(cmd, { stdio: 'pipe' })
    console.log('PASS')
    return true
  } catch (err) {
    console.log('FAIL')
    console.error(err.stdout?.toString().slice(-2000) ?? String(err))
    return false
  }
}

const levelTestsPass = run('unit test suite (npm test)', 'npm test')
const replayPass = run('replay suite (npm run test:replay)', 'npm run test:replay')
const securityScanClean = run('secret scan (npm run secret-scan)', 'npm run secret-scan')
const auditClean = run('dependency audit (npm run audit:deps, informational only)', 'npm run audit:deps')

const status = { levelTestsPass, replayPass, securityScanClean, checkedAt: Date.now() }
mkdirSync(dirname(statusPath), { recursive: true })
writeFileSync(statusPath, JSON.stringify(status, null, 2))

console.log(`\nwrote ${statusPath}:`)
console.log(JSON.stringify(status, null, 2))
if (!auditClean) {
  console.warn(
    '\n⚠ dependency audit found something — this does NOT block the launch gate automatically, ' +
      'but review it before going live (npm run audit:deps).',
  )
}

process.exit(levelTestsPass && replayPass && securityScanClean ? 0 : 1)
