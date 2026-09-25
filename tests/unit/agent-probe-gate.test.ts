import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEther, parseUnits, type Account, type Address } from 'viem'
import { Agent } from '../../src/framework/agent.js'
import { Journal } from '../../src/framework/journal.js'
import { KillSwitch } from '../../src/framework/kill.js'
import type { Market } from '../../src/framework/market.js'
import type { Executor } from '../../src/execution/executor.js'
import type { ProbeGate } from '../../src/execution/probe-gate.js'
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
  maxPositionUsdg: 50,
  maxDailySpendUsdg: 100,
  maxSlippageBps: 100,
  cooldownSeconds: 0,
}

describe('Agent — Level 10 probe gate on live-mode first buys', () => {
  let journal: Journal
  let kill: KillSwitch

  afterEach(() => {
    journal?.close()
    kill?.dispose()
  })

  function makeLiveAgent(opts: {
    market: FakeMarket
    strategy: ScriptedStrategy
    probeGate?: ProbeGate
    execute: ReturnType<typeof vi.fn>
  }) {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const fakeExecutor = { execute: opts.execute } as unknown as Executor
    return new Agent({
      id: 'agent-1',
      strategy: opts.strategy,
      market: opts.market as unknown as Market,
      limits: LIMITS,
      journal,
      kill,
      mode: 'live',
      account: ACCOUNT,
      fleetMaxDailySpendUsdg: 250,
      fleetSpentTodayUsd: () => 0,
      reportFleetSpend: () => {},
      tickIntervalMs: 999_999_999,
      executor: fakeExecutor,
      probeGate: opts.probeGate,
    })
  }

  it('a never-held token with no probeGate configured trades through unchanged (opt-in, not a default)', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const execute = vi.fn().mockResolvedValue({
      state: 'RECONCILED',
      txHash: '0xabc',
      actualAmountOut: parseEther('1000'),
    })
    const agent = makeLiveAgent({ market, strategy, execute })

    await agent.tick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(journal.recentTrades('agent-1', 10)).toHaveLength(1)
  })

  it('a never-held token whose probe just ran this tick is refused — the full-size buy never reaches the executor', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const execute = vi.fn()
    const probeGate = {
      check: vi.fn().mockResolvedValue({ action: 'probed', reason: 'probe passed' }),
    } as unknown as ProbeGate
    const agent = makeLiveAgent({ market, strategy, execute, probeGate })

    await agent.tick()
    expect(probeGate.check).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(journal.recentTrades('agent-1', 10)).toHaveLength(0)
    const decisions = journal.recentDecisions('agent-1', 10)
    expect(decisions[0]?.meta).toMatchObject({ reason: 'probe_ran_this_tick' })
  })

  it('a blacklisted token is refused outright and never reaches the executor', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const execute = vi.fn()
    const probeGate = {
      check: vi
        .fn()
        .mockResolvedValue({ action: 'blacklisted', reason: 'token blacklisted from a prior failed probe' }),
    } as unknown as ProbeGate
    const agent = makeLiveAgent({ market, strategy, execute, probeGate })

    await agent.tick()
    expect(execute).not.toHaveBeenCalled()
    const decisions = journal.recentDecisions('agent-1', 10)
    expect(decisions[0]?.meta).toMatchObject({ reason: 'probe_blacklisted' })
  })

  it('an already-passed token trades through at full size — the gate only ever blocks the FIRST buy', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const execute = vi.fn().mockResolvedValue({
      state: 'RECONCILED',
      txHash: '0xabc',
      actualAmountOut: parseEther('1000'),
    })
    const probeGate = {
      check: vi.fn().mockResolvedValue({ action: 'already_passed', reason: 'probe already passed' }),
    } as unknown as ProbeGate
    const agent = makeLiveAgent({ market, strategy, execute, probeGate })

    await agent.tick()
    expect(probeGate.check).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(journal.recentTrades('agent-1', 10)).toHaveLength(1)
  })

  it('a token the agent already holds skips the gate entirely — only the FIRST buy is probed', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent({ amountIn: parseUnits('5', 6) })])
    strategy.enqueue([buyIntent({ amountIn: parseUnits('5', 6) })])
    const execute = vi.fn().mockResolvedValue({
      state: 'RECONCILED',
      txHash: '0xabc',
      actualAmountOut: parseEther('500'),
    })
    const probeGate = {
      check: vi.fn().mockResolvedValue({ action: 'already_passed', reason: 'probe already passed' }),
    } as unknown as ProbeGate
    const agent = makeLiveAgent({ market, strategy, execute, probeGate })

    await agent.tick()
    await agent.tick()
    expect(probeGate.check).toHaveBeenCalledTimes(1) // not called again once a position exists
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
