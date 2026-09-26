import { describe, expect, it, vi } from 'vitest'
import { parseEther, type Address } from 'viem'
import type { WalletStatsRow } from '../../src/intelligence/wallet-store.js'
import { createRealEmergencyMonitor } from '../../src/exits/emergency-context.js'
import { FakeMarket } from './helpers/fake-market.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address
const SMART_WALLET = '0x3333333333333333333333333333333333333c' as Address
const DEPLOYER = '0x4444444444444444444444444444444444444d' as Address

function walletStats(overrides: Partial<WalletStatsRow> = {}): WalletStatsRow {
  return {
    wallet: SMART_WALLET,
    firstSeen: 0,
    totalTrades: 100,
    winningTrades: 80,
    losingTrades: 20,
    realizedPnlUsd: 10_000,
    unrealizedPnlUsd: 0,
    winRate: 0.8,
    avgWin: 150,
    avgLoss: 150,
    profitFactor: 4,
    maxDrawdownUsd: 0,
    rugExposure: 0,
    medianEntryMcapUsd: null,
    avgHoldMinutes: null,
    earlyEntryScore: 0.9,
    lastUpdated: 0,
    ...overrides,
  }
}

function fakeClient(overrides: { code?: string; balanceOf?: bigint } = {}) {
  return {
    public: {
      getCode: vi.fn().mockResolvedValue(overrides.code ?? '0x'),
      getStorageAt: vi.fn().mockResolvedValue('0x' + '0'.repeat(64)),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'owner') throw new Error('no owner()')
        if (functionName === 'paused') throw new Error('no paused()')
        if (functionName === 'balanceOf') return overrides.balanceOf ?? 0n
        throw new Error(`unexpected call: ${functionName}`)
      }),
      call: vi.fn().mockRejectedValue(new Error('mint probe fails closed')),
    },
  } as never
}

describe('createRealEmergencyMonitor — wires real Level 5 scans + wallet intelligence, never invents new detection logic', () => {
  it('captureEntry reads a deployerAddress from intentMeta when the strategy supplied one', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const walletStore = { recentTransfers: () => [], get: () => null }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient(),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
    })

    const entry = await monitor.captureEntry(TOKEN, WETH, Date.now(), { deployerAddress: DEPLOYER })
    expect(entry.deployerAddress).toBe(DEPLOYER)
    expect(entry.roundTripRetention).toBeCloseTo(0.9, 6)
  })

  it('captureEntry defaults deployerAddress to null when the strategy did not supply one', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const walletStore = { recentTransfers: () => [], get: () => null }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient(),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
    })

    const entry = await monitor.captureEntry(TOKEN, WETH, Date.now(), {})
    expect(entry.deployerAddress).toBeNull()
  })

  it('currentSignals reports real buy/sell pressure from WalletStore.recentTransfers', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const walletStore = {
      recentTransfers: () => [
        { side: 'buy' as const, wallet: '0xaa' as Address, amountUsd: 100, mcapUsd: null, ts: 1 },
        { side: 'sell' as const, wallet: '0xbb' as Address, amountUsd: 400, mcapUsd: null, ts: 2 },
      ],
      get: () => null,
    }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient(),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
    })

    const entry = { liquidityScore: 0, contractRiskScore: 0, roundTripRetention: null, deployerAddress: null }
    const signals = await monitor.currentSignals(TOKEN, WETH, entry, Date.now())
    expect(signals.buyPressureUsd).toBe(100)
    expect(signals.sellPressureUsd).toBe(400)
  })

  it('currentSignals flags smartMoneyNowSelling only when a HIGH-scoring wallet is among the recent sellers', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const walletStore = {
      recentTransfers: () => [
        { side: 'sell' as const, wallet: SMART_WALLET, amountUsd: 50, mcapUsd: null, ts: 1 },
      ],
      get: (w: Address) => (w.toLowerCase() === SMART_WALLET.toLowerCase() ? walletStats() : null),
    }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient(),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
      smartMoneyMinScore: 60,
    })

    const entry = { liquidityScore: 0, contractRiskScore: 0, roundTripRetention: null, deployerAddress: null }
    const signals = await monitor.currentSignals(TOKEN, WETH, entry, Date.now())
    expect(signals.smartMoneyNowSelling).toBe(true)
  })

  it('currentSignals does NOT flag smartMoneyNowSelling when the only seller is a low-scoring wallet', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const lowScoreWallet = '0x5555555555555555555555555555555555555e' as Address
    const walletStore = {
      recentTransfers: () => [
        { side: 'sell' as const, wallet: lowScoreWallet, amountUsd: 50, mcapUsd: null, ts: 1 },
      ],
      get: () =>
        walletStats({ totalTrades: 1, winningTrades: 0, losingTrades: 1, winRate: 0, profitFactor: 0 }),
    }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient(),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
      smartMoneyMinScore: 60,
    })

    const entry = { liquidityScore: 0, contractRiskScore: 0, roundTripRetention: null, deployerAddress: null }
    const signals = await monitor.currentSignals(TOKEN, WETH, entry, Date.now())
    expect(signals.smartMoneyNowSelling).toBe(false)
  })

  it('currentSignals reports deployerBalanceDropped=true when the deployer balance reads zero', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const walletStore = { recentTransfers: () => [], get: () => null }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient({ balanceOf: 0n }),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
    })

    const entry = {
      liquidityScore: 0,
      contractRiskScore: 0,
      roundTripRetention: null,
      deployerAddress: DEPLOYER,
    }
    const signals = await monitor.currentSignals(TOKEN, WETH, entry, Date.now())
    expect(signals.deployerBalanceDropped).toBe(true)
  })

  it('currentSignals reports deployerBalanceDropped=false when no deployerAddress was ever captured', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.9'))
    const walletStore = { recentTransfers: () => [], get: () => null }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient({ balanceOf: 0n }),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
    })

    const entry = { liquidityScore: 0, contractRiskScore: 0, roundTripRetention: null, deployerAddress: null }
    const signals = await monitor.currentSignals(TOKEN, WETH, entry, Date.now())
    expect(signals.deployerBalanceDropped).toBe(false)
  })

  it('a scan that throws resolves a neutral value rather than propagating (fail-open on this EXTRA layer only)', async () => {
    const market = new FakeMarket() // no routes configured at all -> checkSellability sees "not sellable"
    const walletStore = { recentTransfers: () => [], get: () => null }
    const monitor = createRealEmergencyMonitor({
      client: fakeClient(),
      market: market as never,
      walletStore,
      probeAmountIn: parseEther('1'),
    })

    await expect(monitor.captureEntry(TOKEN, WETH, Date.now(), {})).resolves.toMatchObject({
      liquidityScore: 0,
    })
  })
})
