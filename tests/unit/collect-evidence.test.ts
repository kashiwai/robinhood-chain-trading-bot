import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address } from 'viem'
import { Journal } from '../../src/framework/journal.js'
import { OrderStore } from '../../src/execution/order-store.js'
import { ProbeStore } from '../../src/execution/probe-store.js'
import { ShadowRunTracker } from '../../src/gates/shadow-run.js'
import { collectLaunchGateEvidence } from '../../src/gates/collect-evidence.js'

const TOKEN_A = '0x1111111111111111111111111111111111111a' as Address
const TOKEN_B = '0x2222222222222222222222222222222222222b' as Address
const WETH = '0x3333333333333333333333333333333333333c' as Address

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function baseOpts(
  journal: Journal,
  orderStore: OrderStore,
  probeStore: ProbeStore,
  shadowRun: ShadowRunTracker,
) {
  return {
    journal,
    orderStore,
    probeStore,
    shadowRun,
    levelTestsPass: true,
    replayPass: true,
    securityScanClean: true,
    backupLastRunAt: Date.now(),
    restartRecoveryWired: true,
  }
}

describe('collectLaunchGateEvidence — real data, not operator-asserted booleans', () => {
  it('counts real closed paper trades from the journal', () => {
    const journal = new Journal(':memory:')
    journal.recordTrade({
      agentId: 'a',
      mode: 'paper',
      ts: 1,
      side: 'buy',
      token: TOKEN_A,
      tokenSymbol: 'X',
      quoteToken: WETH,
      quoteSymbol: 'WETH',
      amountIn: 0n,
      amountOut: 100n,
      txHash: null,
      reason: 'r',
      slippageBps: 50,
      gasEstimate: 0n,
      meta: { notionalUsd: 10 },
    })
    journal.recordTrade({
      agentId: 'a',
      mode: 'paper',
      ts: 2,
      side: 'sell',
      token: TOKEN_A,
      tokenSymbol: 'X',
      quoteToken: WETH,
      quoteSymbol: 'WETH',
      amountIn: 100n,
      amountOut: 0n,
      txHash: null,
      reason: 'r',
      slippageBps: 50,
      gasEstimate: 0n,
      meta: { notionalUsd: 15 },
    })
    dir = mkdtempSync(join(tmpdir(), 'evid-'))
    const orderStore = new OrderStore(':memory:')
    const probeStore = new ProbeStore(':memory:')
    const shadowRun = new ShadowRunTracker(join(dir, 'shadow.json'))

    const evidence = collectLaunchGateEvidence(baseOpts(journal, orderStore, probeStore, shadowRun))
    expect(evidence.paperClosedTrades).toBe(1) // one closed round trip

    journal.close()
    orderStore.close()
    probeStore.close()
  })

  it('a probe that failed counts as mismatch/unrecoverable, not reconciled', () => {
    dir = mkdtempSync(join(tmpdir(), 'evid-'))
    const journal = new Journal(':memory:')
    const orderStore = new OrderStore(':memory:')
    const probeStore = new ProbeStore(':memory:')
    const shadowRun = new ShadowRunTracker(join(dir, 'shadow.json'))

    probeStore.record({
      token: TOKEN_A,
      passed: false,
      reason: 'sell failed',
      measuredBuyTaxBps: null,
      measuredSellTaxBps: null,
      ts: 1,
    })

    const evidence = collectLaunchGateEvidence(baseOpts(journal, orderStore, probeStore, shadowRun))
    expect(evidence.probeCyclesCompleted).toBe(1)
    expect(evidence.probeReconciledCount).toBe(0)
    expect(evidence.probeMismatchOrUnrecoverableCount).toBe(1)

    journal.close()
    orderStore.close()
    probeStore.close()
  })

  it('a passed probe with BOTH buy and sell orders RECONCILED counts as reconciled', () => {
    dir = mkdtempSync(join(tmpdir(), 'evid-'))
    const journal = new Journal(':memory:')
    const orderStore = new OrderStore(':memory:')
    const probeStore = new ProbeStore(':memory:')
    const shadowRun = new ShadowRunTracker(join(dir, 'shadow.json'))

    probeStore.record({
      token: TOKEN_A,
      passed: true,
      reason: 'ok',
      measuredBuyTaxBps: 50,
      measuredSellTaxBps: 50,
      ts: 1,
    })
    orderStore.createOrder({
      idempotencyKey: `probe-buy:${TOKEN_A.toLowerCase()}`,
      agentId: 'probe',
      token: TOKEN_A,
      side: 'buy',
      quoteToken: WETH,
      amountIn: '1',
    })
    orderStore.transition(`probe-buy:${TOKEN_A.toLowerCase()}`, 'RECONCILED')
    orderStore.createOrder({
      idempotencyKey: `probe-sell:${TOKEN_A.toLowerCase()}`,
      agentId: 'probe',
      token: TOKEN_A,
      side: 'sell',
      quoteToken: WETH,
      amountIn: '1',
    })
    orderStore.transition(`probe-sell:${TOKEN_A.toLowerCase()}`, 'RECONCILED')

    const evidence = collectLaunchGateEvidence(baseOpts(journal, orderStore, probeStore, shadowRun))
    expect(evidence.probeReconciledCount).toBe(1)
    expect(evidence.probeMismatchOrUnrecoverableCount).toBe(0)

    journal.close()
    orderStore.close()
    probeStore.close()
  })

  it('a passed probe whose sell order never reached RECONCILED counts as a mismatch, despite the probe itself reporting "passed"', () => {
    dir = mkdtempSync(join(tmpdir(), 'evid-'))
    const journal = new Journal(':memory:')
    const orderStore = new OrderStore(':memory:')
    const probeStore = new ProbeStore(':memory:')
    const shadowRun = new ShadowRunTracker(join(dir, 'shadow.json'))

    probeStore.record({
      token: TOKEN_B,
      passed: true,
      reason: 'ok',
      measuredBuyTaxBps: 0,
      measuredSellTaxBps: 0,
      ts: 1,
    })
    orderStore.createOrder({
      idempotencyKey: `probe-buy:${TOKEN_B.toLowerCase()}`,
      agentId: 'probe',
      token: TOKEN_B,
      side: 'buy',
      quoteToken: WETH,
      amountIn: '1',
    })
    orderStore.transition(`probe-buy:${TOKEN_B.toLowerCase()}`, 'RECONCILED')
    // sell order was never even created — a genuine reconciliation gap despite ProbeStore saying "passed"

    const evidence = collectLaunchGateEvidence(baseOpts(journal, orderStore, probeStore, shadowRun))
    expect(evidence.probeMismatchOrUnrecoverableCount).toBe(1)
    expect(evidence.probeReconciledCount).toBe(0)

    journal.close()
    orderStore.close()
    probeStore.close()
  })

  it("passes through the shadow run tracker's real numbers", () => {
    dir = mkdtempSync(join(tmpdir(), 'evid-'))
    const journal = new Journal(':memory:')
    const orderStore = new OrderStore(':memory:')
    const probeStore = new ProbeStore(':memory:')
    const shadowRun = new ShadowRunTracker(join(dir, 'shadow.json'))
    shadowRun.recordHealthCheck(true)
    shadowRun.recordHealthCheck(true)
    shadowRun.recordHealthCheck(false)

    const evidence = collectLaunchGateEvidence(baseOpts(journal, orderStore, probeStore, shadowRun))
    expect(evidence.shadowUptimePct).toBeCloseTo(2 / 3, 6)

    journal.close()
    orderStore.close()
    probeStore.close()
  })
})
