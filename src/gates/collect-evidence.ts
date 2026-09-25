import type { Journal } from '../framework/journal.js'
import { OrderStore } from '../execution/order-store.js'
import { ProbeStore } from '../execution/probe-store.js'
import { ShadowRunTracker } from './shadow-run.js'
import { computePerformance } from '../analytics/performance.js'
import type { LaunchGateEvidence } from './launch-gate.js'

export interface CollectEvidenceOptions {
  journal: Journal
  orderStore: OrderStore
  probeStore: ProbeStore
  shadowRun: ShadowRunTracker
  /** Result of actually running `npm test` — this function does not shell out itself (see scripts/check-launch-gate.mjs, which does). */
  levelTestsPass: boolean
  replayPass: boolean
  securityScanClean: boolean
  backupLastRunAt: number | null
  /** Static fact about this codebase (Level 6 wires recoverPendingOrders into main.ts's live-mode startup) — not re-derived at runtime. */
  restartRecoveryWired: boolean
}

/**
 * Assembles {@link LaunchGateEvidence} from the ACTUAL running system —
 * real journal trades, real probe/order records, a real persisted shadow-
 * run clock — rather than operator-asserted booleans. The pieces this
 * function genuinely cannot determine on its own (did the test suite pass,
 * is the security scan clean) are passed in by the caller, which — for a
 * real launch-gate check — got them by actually running those checks (see
 * scripts/check-launch-gate.mjs), not by asking a human to type "yes".
 */
export function collectLaunchGateEvidence(opts: CollectEvidenceOptions): LaunchGateEvidence {
  const paperTrades = opts.journal.allTradesInMode('paper')
  const paperPerf = computePerformance(paperTrades)

  const probes = opts.probeStore.allRecords()
  const orders = opts.orderStore.allOrders()
  let reconciled = 0
  let mismatchOrUnrecoverable = 0
  for (const probe of probes) {
    if (!probe.passed) {
      mismatchOrUnrecoverable += 1 // a failed probe IS the "unrecoverable sell failure / mismatch" case the spec's 10-D counts against 20/20
      continue
    }
    const buyKey = `probe-buy:${probe.token.toLowerCase()}`
    const sellKey = `probe-sell:${probe.token.toLowerCase()}`
    const buyOrder = orders.find((o) => o.idempotencyKey === buyKey)
    const sellOrder = orders.find((o) => o.idempotencyKey === sellKey)
    if (buyOrder?.state === 'RECONCILED' && sellOrder?.state === 'RECONCILED') {
      reconciled += 1
    } else {
      mismatchOrUnrecoverable += 1
    }
  }

  return {
    levelTestsPass: opts.levelTestsPass,
    replayPass: opts.replayPass,
    shadowHoursCompleted: opts.shadowRun.hoursCompleted(),
    shadowUptimePct: opts.shadowRun.uptimePct(),
    paperClosedTrades: paperPerf.winningTrades + paperPerf.losingTrades,
    probeCyclesCompleted: probes.length,
    probeReconciledCount: reconciled,
    probeMismatchOrUnrecoverableCount: mismatchOrUnrecoverable,
    securityScanClean: opts.securityScanClean,
    backupLastRunAt: opts.backupLastRunAt,
    restartRecoveryWired: opts.restartRecoveryWired,
  }
}
