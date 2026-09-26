import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEther, parseUnits, type Account, type Address } from 'viem'
import { Agent } from '../../src/framework/agent.js'
import { Journal } from '../../src/framework/journal.js'
import { KillSwitch } from '../../src/framework/kill.js'
import type { Market } from '../../src/framework/market.js'
import type { Executor } from '../../src/execution/executor.js'
import type { EmergencyMonitorHooks } from '../../src/exits/emergency-monitor.js'
import type { Strategy, StrategyTickContext } from '../../src/framework/strategy.js'
import type { Decision, Intent, RiskLimits } from '../../src/framework/types.js'
import { FakeMarket } from './helpers/fake-market.js'

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const TOKEN_A = '0x2222222222222222222222222222222222222b' as Address
const ACCOUNT = { address: '0x1111111111111111111111111111111111111a' } as Account

class ScriptedStrategy implements Strategy {
  readonly id = 'scripted'
  readonly title = 'Scripted'
  readonly quote = 'usdg' as const
  readonly meta = { edge: 'test double', failureModes: ['n/a'], params: {} }
  private queue: Intent[][] = []
  enqueue(intents: Intent[]): void {
    this.queue.push(intents)
  }
  async tick(_ctx: StrategyTickContext): Promise<Decision> {
    return { intents: this.queue.shift() ?? [], alerts: [] }
  }
}

function buyIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    side: 'buy',
    token: TOKEN_A,
    tokenSymbol: 'MEME',
    amountIn: parseUnits('10', 6),
    quoteToken: USDG,
    quoteSymbol: 'USDG',
    reason: 'test entry',
    ...overrides,
  }
}

const LIMITS: RiskLimits = {
  maxPositionUsdg: 1000,
  maxDailySpendUsdg: 1000,
  maxSlippageBps: 10_000,
  cooldownSeconds: 0,
}

describe('Agent — Level 10.1 emergency exit wired into the position-monitoring path', () => {
  let journal: Journal
  let kill: KillSwitch

  afterEach(() => {
    journal?.close()
    kill?.dispose()
  })

  function makeAgent(opts: {
    market: FakeMarket
    strategy: ScriptedStrategy
    mode?: 'paper' | 'live'
    executor?: Executor
    execute?: ReturnType<typeof vi.fn>
    emergencyMonitor?: EmergencyMonitorHooks
  }) {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    let fleetSpent = 0
    const executor = opts.execute ? ({ execute: opts.execute } as unknown as Executor) : opts.executor
    return new Agent({
      id: 'agent-1',
      strategy: opts.strategy,
      market: opts.market as unknown as Market,
      limits: LIMITS,
      journal,
      kill,
      mode: opts.mode ?? 'paper',
      account: opts.mode === 'live' ? ACCOUNT : null,
      fleetMaxDailySpendUsdg: 1000,
      fleetSpentTodayUsd: () => fleetSpent,
      reportFleetSpend: (usd) => {
        fleetSpent += usd
      },
      tickIntervalMs: 999_999_999,
      executor,
      emergencyMonitor: opts.emergencyMonitor,
    })
  }

  it('an emergencyMonitor reporting smart-money-now-selling triggers an automatic full exit — no strategy sell intent involved at all', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()]) // tick 1: open the position
    strategy.enqueue([]) // tick 2: strategy itself proposes nothing
    const emergencyMonitor: EmergencyMonitorHooks = {
      captureEntry: async () => ({
        liquidityScore: 0,
        contractRiskScore: 0,
        roundTripRetention: null,
        deployerAddress: null,
      }),
      currentSignals: async () => ({ smartMoneyNowSelling: true }),
    }
    const agent = makeAgent({ market, strategy, emergencyMonitor })

    await agent.tick() // opens the position
    expect(agent.status().positions).toHaveLength(1)

    await agent.tick() // emergency monitor should close it before the strategy's (empty) decision even matters
    expect(agent.status().positions).toHaveLength(0)

    const decisions = journal.recentDecisions('agent-1', 20)
    const triggered = decisions.find((d) => d.kind === 'emergency_exit' && d.meta.phase === 'triggered')
    const resolved = decisions.find((d) => d.kind === 'emergency_exit' && d.meta.phase === 'resolved')
    expect(triggered?.meta.trigger).toContain('cluster_smart_money_exit')
    expect(resolved?.meta.result).toBe('sold')
  })

  it('with NO emergencyMonitor configured, a >50% single-tick price crash (quote anomaly) alone still triggers an emergency exit', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([]) // first real mark — establishes the baseline, nothing to compare against yet
    strategy.enqueue([])
    const agent = makeAgent({ market, strategy }) // no emergencyMonitor at all

    await agent.tick() // opens the position (markUsd still null this tick)
    expect(agent.status().positions).toHaveLength(1)

    await agent.tick() // first real mark at $9 — the baseline
    expect(agent.status().positions).toHaveLength(1)

    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('4', 6)) // crashes to well under half of the baseline
    await agent.tick()

    expect(agent.status().positions).toHaveLength(0)
    const decisions = journal.recentDecisions('agent-1', 20)
    const triggered = decisions.find((d) => d.kind === 'emergency_exit' && d.meta.phase === 'triggered')
    expect(triggered?.meta.trigger).toContain('rpc_quote_anomaly')
  })

  it('emergency exit preempts the strategy: a strategy sell intent for an already-emergency-closed position is refused, never double-sold', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const emergencyMonitor: EmergencyMonitorHooks = {
      captureEntry: async () => ({
        liquidityScore: 0,
        contractRiskScore: 0,
        roundTripRetention: null,
        deployerAddress: null,
      }),
      currentSignals: async () => ({ smartMoneyNowSelling: true }),
    }
    const agent = makeAgent({ market, strategy, emergencyMonitor })
    await agent.tick() // open

    // tick 2: the strategy ALSO independently decides to sell the whole position
    // (simulating a hard-stop/normal-exit/JEV decision) — but the emergency
    // monitor runs first and should have already closed it out.
    strategy.enqueue([
      {
        side: 'sell',
        token: TOKEN_A,
        tokenSymbol: 'MEME',
        amountIn: parseEther('1000'),
        quoteToken: USDG,
        quoteSymbol: 'USDG',
        reason: 'strategy exit',
      },
    ])
    await agent.tick()

    expect(agent.status().positions).toHaveLength(0)
    const decisions = journal.recentDecisions('agent-1', 20)
    // the strategy's own late sell intent must have been refused (no position left to sell)
    const lateRefusal = decisions.find(
      (d) => d.kind === 'refused' && d.meta.reason === 'insufficient_balance',
    )
    expect(lateRefusal).toBeDefined()
    // exactly one emergency exit was journaled (not one per tick, and not duplicated by the strategy's own attempt)
    const resolvedCount = decisions.filter(
      (d) => d.kind === 'emergency_exit' && d.meta.phase === 'resolved' && d.meta.result === 'sold',
    ).length
    expect(resolvedCount).toBe(1)
  })

  it('a failed emergency SELL (no sell route) does NOT delete or shrink the position', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([])
    const emergencyMonitor: EmergencyMonitorHooks = {
      captureEntry: async () => ({
        liquidityScore: 0,
        contractRiskScore: 0,
        roundTripRetention: null,
        deployerAddress: null,
      }),
      currentSignals: async () => ({ smartMoneyNowSelling: true }),
    }
    const agent = makeAgent({ market, strategy, emergencyMonitor })
    await agent.tick() // open
    const openedAmount = agent.status().positions[0]!.amount

    market.sellRoutes.delete(TOKEN_A.toLowerCase()) // sell now fails outright
    await agent.tick() // emergency fires, sell attempt fails

    const positions = agent.status().positions
    expect(positions).toHaveLength(1)
    expect(positions[0]!.amount).toBe(openedAmount) // untouched, not partially reduced or deleted

    const decisions = journal.recentDecisions('agent-1', 20)
    const resolved = decisions.find((d) => d.kind === 'emergency_exit' && d.meta.phase === 'resolved')
    expect(resolved?.meta.result).toBe('failed')
  })

  it('idempotency: repeated emergency triggers for the SAME still-open position reuse the identical idempotency key (Level 6 order-store dedup applies)', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([])
    strategy.enqueue([])
    const emergencyMonitor: EmergencyMonitorHooks = {
      captureEntry: async () => ({
        liquidityScore: 0,
        contractRiskScore: 0,
        roundTripRetention: null,
        deployerAddress: null,
      }),
      currentSignals: async () => ({ smartMoneyNowSelling: true }),
    }
    const execute = vi
      .fn()
      .mockImplementation(async (input: { side: 'buy' | 'sell'; idempotencyKey: string }) => ({
        idempotencyKey: input.idempotencyKey,
        agentId: 'agent-1',
        token: TOKEN_A,
        side: input.side,
        quoteToken: USDG,
        amountIn: 0n,
        // buys succeed (so a position actually opens); every sell fails, so the
        // position stays open and the emergency monitor keeps retrying.
        state: input.side === 'buy' ? 'RECONCILED' : 'FAILED',
        nonce: null,
        txHash: input.side === 'buy' ? '0xabc' : null,
        quotedAmountOut: null,
        actualAmountOut: input.side === 'buy' ? parseEther('1000') : null,
        actualPrice: null,
        actualSlippageBps: null,
        error: input.side === 'sell' ? 'simulated failure' : null,
        attempts: 1,
        createdAt: 0,
        submittedAt: null,
        minedAt: null,
        confirmedAt: null,
        reconciledAt: null,
      }))
    const agent = makeAgent({ market, strategy, mode: 'live', execute, emergencyMonitor })

    await agent.tick() // open (paper-style buy path still used since executor untouched for buys with a route... )
    await agent.tick() // 1st emergency sell attempt (fails)
    await agent.tick() // 2nd emergency sell attempt (fails again — position never closed)

    const sellCalls = execute.mock.calls.filter((c) => c[0].side === 'sell')
    expect(sellCalls.length).toBeGreaterThanOrEqual(2)
    const keys = new Set(sellCalls.map((c) => c[0].idempotencyKey))
    expect(keys.size).toBe(1) // every attempt for this position used the SAME deterministic key
    expect([...keys][0]).toMatch(/^emergency-exit:/)
  })
})
