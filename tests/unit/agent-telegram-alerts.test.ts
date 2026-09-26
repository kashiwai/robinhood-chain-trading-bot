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

describe('Agent — Level 10.1 Telegram critical alerts', () => {
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
    execute?: ReturnType<typeof vi.fn>
    emergencyMonitor?: EmergencyMonitorHooks
    send: ReturnType<typeof vi.fn>
  }) {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    let fleetSpent = 0
    const executor = opts.execute ? ({ execute: opts.execute } as unknown as Executor) : undefined
    return new Agent({
      id: 'agent-1',
      strategy: opts.strategy,
      market: opts.market as unknown as Market,
      limits: LIMITS,
      journal,
      kill,
      mode: opts.mode ?? 'live',
      account: ACCOUNT,
      fleetMaxDailySpendUsdg: 1000,
      fleetSpentTodayUsd: () => fleetSpent,
      reportFleetSpend: (usd) => {
        fleetSpent += usd
      },
      tickIntervalMs: 999_999_999,
      executor,
      emergencyMonitor: opts.emergencyMonitor,
      telegramAlerter: { send: opts.send },
    })
  }

  function liveExecute(overrides: { buyOk?: boolean; sellOk?: boolean } = {}) {
    const buyOk = overrides.buyOk ?? true
    const sellOk = overrides.sellOk ?? true
    return vi.fn().mockImplementation(async (input: { side: 'buy' | 'sell'; idempotencyKey: string }) => ({
      idempotencyKey: input.idempotencyKey,
      agentId: 'agent-1',
      token: TOKEN_A,
      side: input.side,
      quoteToken: USDG,
      amountIn: 0n,
      state: (input.side === 'buy' ? buyOk : sellOk) ? 'RECONCILED' : 'FAILED',
      nonce: null,
      txHash: (input.side === 'buy' ? buyOk : sellOk) ? '0xabc' : null,
      quotedAmountOut: null,
      actualAmountOut: (input.side === 'buy' ? buyOk : sellOk) ? parseEther('1000') : null,
      actualPrice: null,
      actualSlippageBps: null,
      error: (input.side === 'buy' ? buyOk : sellOk) ? null : 'simulated failure',
      attempts: 1,
      createdAt: 0,
      submittedAt: null,
      minedAt: null,
      confirmedAt: null,
      reconciledAt: null,
    }))
  }

  it('a successful LIVE buy sends REAL_BUY', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const send = vi.fn().mockResolvedValue(undefined)
    const agent = makeAgent({ market, strategy, execute: liveExecute(), send })

    await agent.tick()
    expect(send).toHaveBeenCalledWith('REAL_BUY', expect.stringContaining('MEME'))
  })

  it('a successful LIVE sell sends REAL_SELL', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([
      {
        side: 'sell',
        token: TOKEN_A,
        tokenSymbol: 'MEME',
        amountIn: parseEther('1000'),
        quoteToken: USDG,
        quoteSymbol: 'USDG',
        reason: 'exit',
      },
    ])
    const send = vi.fn().mockResolvedValue(undefined)
    const agent = makeAgent({ market, strategy, execute: liveExecute(), send })

    await agent.tick()
    await agent.tick()
    expect(send).toHaveBeenCalledWith('REAL_SELL', expect.stringContaining('MEME'))
  })

  it('a paper-mode trade sends no alert at all (REAL_BUY/REAL_SELL are for real money only)', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const send = vi.fn().mockResolvedValue(undefined)
    const agent = makeAgent({ market, strategy, mode: 'paper', send })

    await agent.tick()
    expect(send).not.toHaveBeenCalled()
  })

  it('a failed LIVE sell (non-emergency) sends SELL_FAILURE', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([
      {
        side: 'sell',
        token: TOKEN_A,
        tokenSymbol: 'MEME',
        amountIn: parseEther('1000'),
        quoteToken: USDG,
        quoteSymbol: 'USDG',
        reason: 'exit',
      },
    ])
    const send = vi.fn().mockResolvedValue(undefined)
    const agent = makeAgent({ market, strategy, execute: liveExecute({ sellOk: false }), send })

    await agent.tick()
    await agent.tick()
    expect(send).toHaveBeenCalledWith('SELL_FAILURE', expect.stringContaining('MEME'))
    expect(send).not.toHaveBeenCalledWith('EMERGENCY_EXIT', expect.anything())
  })

  it('an emergency exit sends EMERGENCY_EXIT, and does NOT also send a separate SELL_FAILURE/REAL_SELL for the same event', async () => {
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
    const send = vi.fn().mockResolvedValue(undefined)
    const agent = makeAgent({ market, strategy, execute: liveExecute(), emergencyMonitor, send })

    await agent.tick()
    await agent.tick()

    expect(send).toHaveBeenCalledWith('EMERGENCY_EXIT', expect.stringContaining('MEME'))
    expect(send).toHaveBeenCalledWith('REAL_SELL', expect.anything()) // the successful sell itself still fires REAL_SELL
    expect(send).not.toHaveBeenCalledWith('SELL_FAILURE', expect.anything())
  })

  it('a FAILED emergency exit sells sends EMERGENCY_EXIT (with the failure noted) but not a duplicate SELL_FAILURE', async () => {
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
    const send = vi.fn().mockResolvedValue(undefined)
    const agent = makeAgent({
      market,
      strategy,
      execute: liveExecute({ sellOk: false }),
      emergencyMonitor,
      send,
    })

    await agent.tick()
    await agent.tick()

    const emergencyCall = send.mock.calls.find((c) => c[0] === 'EMERGENCY_EXIT')
    expect(emergencyCall?.[1]).toMatch(/FAILED/)
    expect(send).not.toHaveBeenCalledWith('SELL_FAILURE', expect.anything())
  })
})
