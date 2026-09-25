import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { parseEther } from 'viem'
import { LaunchSniper } from '../../src/strategies/launch-sniper.js'
import { Momentum } from '../../src/strategies/momentum.js'
import { PremiumWatch } from '../../src/strategies/premium-watch.js'
import type { Position } from '../../src/framework/types.js'
import type { Market } from '../../src/framework/market.js'
import type { StrategyTickContext } from '../../src/framework/strategy.js'
import { FakeMarket } from './helpers/fake-market.js'
import { EventQueue } from '../../src/discovery/event-queue.js'
import { LAUNCH_KIND, encodeLaunchPayload } from '../../src/discovery/launch-detector.js'

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL('../snapshots/latest.json', import.meta.url)), 'utf8'),
) as {
  ethUsd: number
  quotes: { symbol: string; address: Address; priceUsd: number; ageSeconds: number; roundId: string }[]
}

const AAPL = snapshot.quotes.find((q) => q.symbol === 'AAPL')!
const TOKEN_A = '0x2222222222222222222222222222222222222b' as Address
const CREATOR = '0x3333333333333333333333333333333333333c' as Address
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address

function ctxFor(
  market: FakeMarket,
  positions: Position[],
  now: number,
  quote: 'usdg' | 'weth',
): StrategyTickContext {
  return {
    market: market as unknown as Market,
    positions,
    now,
    quoteToken: quote === 'weth' ? WETH : USDG,
    quoteSymbol: quote === 'weth' ? 'WETH' : 'USDG',
    quoteDecimals: quote === 'weth' ? 18 : 6,
    log: () => {},
  }
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    token: TOKEN_A,
    tokenSymbol: 'MEME',
    amount: parseEther('100'),
    costBasis: parseEther('0.01'),
    investedUsd: 20,
    quoteToken: WETH,
    quoteSymbol: 'WETH',
    openedAt: 0,
    markUsd: null,
    meta: {},
    ...overrides,
  }
}

describe('LaunchSniper — exits (Level 9 tier ladder, pure math, no market calls)', () => {
  it('TP1 fires at the configured threshold, selling a partial fraction (not the whole position)', async () => {
    const sniper = new LaunchSniper({ exitConfig: { tp1Pct: 0.5, tp1SellFraction: 0.25 } })
    const market = new FakeMarket()
    const pos = position({ investedUsd: 20, markUsd: 32, openedAt: 0 }) // +60%, clears the 50% TP1 bar
    const decision = await sniper.tick(ctxFor(market, [pos], 60_000, 'weth'))
    expect(decision.intents).toHaveLength(1)
    expect(decision.intents[0]?.side).toBe('sell')
    expect(decision.intents[0]?.reason).toMatch(/take-profit-1/)
    expect(decision.intents[0]?.amountIn).toBe(pos.amount / 4n) // 25% of the position
    expect(pos.meta.exitState).toEqual({ tp1Taken: true, tp2Taken: false, peakPnlPctSinceTp2: -Infinity })
  })

  it('exits fully on stop-loss once markUsd/investedUsd breaches the floor', async () => {
    const sniper = new LaunchSniper({ exitConfig: { stopLossPct: 0.3 } })
    const market = new FakeMarket()
    const pos = position({ investedUsd: 20, markUsd: 12, openedAt: 0 }) // -40%
    const decision = await sniper.tick(ctxFor(market, [pos], 60_000, 'weth'))
    expect(decision.intents[0]?.reason).toMatch(/stop-loss/)
    expect(decision.intents[0]?.amountIn).toBe(pos.amount) // full exit
  })

  it('force-exits after maxHoldSeconds regardless of PnL', async () => {
    const sniper = new LaunchSniper({ maxHoldSeconds: 60, exitConfig: { tp1Pct: 10, stopLossPct: 10 } })
    const market = new FakeMarket()
    const pos = position({ investedUsd: 20, markUsd: 20.5, openedAt: 0 }) // flat PnL, well within TP/SL
    const decision = await sniper.tick(ctxFor(market, [pos], 120_000, 'weth')) // 120s held > 60s max
    expect(decision.intents[0]?.reason).toMatch(/time-exit/)
  })

  it('holds a position inside every band (no tier cleared, well under the time cap)', async () => {
    const sniper = new LaunchSniper({ exitConfig: { tp1Pct: 0.5, stopLossPct: 0.3 }, maxHoldSeconds: 600 })
    const market = new FakeMarket()
    const pos = position({ investedUsd: 20, markUsd: 21, openedAt: 0 }) // +5%, 30s held
    const decision = await sniper.tick(ctxFor(market, [pos], 30_000, 'weth'))
    expect(decision.intents).toHaveLength(0)
  })

  it('a full TP1 -> TP2 -> trailing-stop sequence plays out across ticks, exit state persisted in pos.meta', async () => {
    const sniper = new LaunchSniper({ exitConfig: { tp1Pct: 0.2, tp2Pct: 0.4, trailingStopPct: 0.15 } })
    const market = new FakeMarket()
    const pos = position({ investedUsd: 20, markUsd: 24.1, openedAt: 0 }) // +20.5% -> clears the 20% TP1 bar
    // (24.1, not 24 exactly — 24/20-1 lands a hair under 0.2 in IEEE754 float subtraction, which would
    // miss the >= 0.2 gate; using a value unambiguously past the threshold avoids that, same as any
    // float-threshold comparison in real market data, which is never exactly on the boundary either.)

    let decision = await sniper.tick(ctxFor(market, [pos], 10_000, 'weth'))
    expect(decision.intents[0]?.reason).toMatch(/take-profit-1/)

    pos.markUsd = 28.1 // +40.5% -> clears the 40% TP2 bar
    decision = await sniper.tick(ctxFor(market, [pos], 20_000, 'weth'))
    expect(decision.intents[0]?.reason).toMatch(/take-profit-2/)

    pos.markUsd = 26 // back to +30%, 10pt off the 40% peak — inside the 15pt trailing band, holds
    decision = await sniper.tick(ctxFor(market, [pos], 30_000, 'weth'))
    expect(decision.intents).toHaveLength(0)

    pos.markUsd = 22.8 // +14%, 26pt off the 40% peak — past the 15pt trail
    decision = await sniper.tick(ctxFor(market, [pos], 40_000, 'weth'))
    expect(decision.intents[0]?.reason).toMatch(/trailing-stop/)
  })
})

describe('LaunchSniper — entry filters (using a queued candidate + FakeMarket)', () => {
  let seq = 0

  // Seeds a fresh in-memory durable EventQueue exactly the way LaunchDetector
  // does in production (see discovery/launch-detector.ts), so these tests
  // exercise the real claim → evaluate → mark-terminal path instead of poking
  // a private field.
  function seededQueue(launch: {
    token: Address
    creator: Address
    launchpad: 'noxa' | 'odyssey'
    pool: Address | null
  }): EventQueue {
    const queue = new EventQueue(':memory:')
    seq += 1
    queue.recordDetected({
      chainId: 4663,
      blockNumber: 1n,
      transactionHash: `0xdead${seq}` as `0x${string}`,
      discriminator: launch.token,
      kind: LAUNCH_KIND,
      payload: encodeLaunchPayload({
        ...launch,
        blockNumber: 1n,
        transactionHash: `0xdead${seq}` as `0x${string}`,
      }),
    })
    const eventId = EventQueue.eventId({
      chainId: 4663,
      blockNumber: 1n,
      transactionHash: `0xdead${seq}`,
      discriminator: launch.token,
    })
    queue.markQueued(eventId)
    return queue
  }

  it('skips a launch with no liquid Uniswap route (e.g. an un-graduated Odyssey curve token)', async () => {
    const market = new FakeMarket()
    // no buyRoutes entry for TOKEN_A → quoteBuy resolves null
    const queue = seededQueue({ token: TOKEN_A, creator: CREATOR, launchpad: 'odyssey', pool: null })
    const sniper = new LaunchSniper({}, queue)
    const decision = await sniper.tick(ctxFor(market, [], Date.now(), 'weth'))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/no liquid Uniswap route/)
    expect(queue.stateCounts(LAUNCH_KIND).rejected).toBe(1)
  })

  it('skips a honeypot: buy succeeds but sell-back resolves no route', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    // no sellRoutes entry → quoteSell resolves null
    const queue = seededQueue({ token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })
    const sniper = new LaunchSniper({}, queue)
    const decision = await sniper.tick(ctxFor(market, [], Date.now(), 'weth'))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/honeypot/)
  })

  it('skips a launch whose round-trip loses more than the configured threshold', async () => {
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    // Sell back only 70% of the input value — a 30% round-trip loss, over the 20% cap.
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 70n) / 100n)
    market.multicallResults = [parseEther('1000000'), 0n] // supply, deployer balance
    const queue = seededQueue({ token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })
    const sniper = new LaunchSniper({ maxRoundTripLossPct: 0.2, entryWeth: 0.01 }, queue)
    const decision = await sniper.tick(ctxFor(market, [], Date.now(), 'weth'))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/round-trip loss/)
  })

  it('skips a launch where the deployer holds more than the concentration cap', async () => {
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 98n) / 100n) // clean round trip
    // deployer holds 25% of supply — over the 10% cap
    market.multicallResults = [parseEther('1000'), parseEther('250')]
    const queue = seededQueue({ token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })
    const sniper = new LaunchSniper({ maxDeployerPct: 0.1 }, queue)
    const decision = await sniper.tick(ctxFor(market, [], Date.now(), 'weth'))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/deployer holds/)
  })

  it('enters when every filter clears', async () => {
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 98n) / 100n)
    market.multicallResults = [parseEther('1000'), parseEther('10')] // deployer holds 1%
    const queue = seededQueue({ token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })
    const sniper = new LaunchSniper({ maxDeployerPct: 0.5, maxRoundTripLossPct: 0.5, entryWeth: 0.01 }, queue)
    const decision = await sniper.tick(ctxFor(market, [], Date.now(), 'weth'))
    expect(decision.intents).toHaveLength(1)
    expect(decision.intents[0]?.side).toBe('buy')
    expect(decision.intents[0]?.amountIn).toBe(amountIn)
    expect(queue.stateCounts(LAUNCH_KIND).decisioned).toBe(1)
  })

  it('reports its edge hypothesis and failure modes (documentation contract)', () => {
    const sniper = new LaunchSniper()
    expect(sniper.meta.edge.length).toBeGreaterThan(20)
    expect(sniper.meta.failureModes.length).toBeGreaterThanOrEqual(3)
  })
})

describe('Momentum — breakout entries and trailing-stop exits', () => {
  function seededHistory(
    momentum: Momentum,
    token: Address,
    symbol: string,
    samples: { ts: number; priceUsd: number }[],
    now: number,
  ) {
    const internal = momentum as unknown as {
      history: Map<string, { token: Address; symbol: string; samples: typeof samples }>
      lastDiscoveryAt: number
    }
    internal.history.set(token.toLowerCase(), { token, symbol, samples })
    internal.lastDiscoveryAt = now // skip live discovery (a real chain log scan) in this tick
  }

  it('fires a breakout entry using real AAPL-scale prices from the captured snapshot', async () => {
    // AAPL real price from the snapshot as the window's starting point; a synthetic
    // +20% move over the lookback window (over the 15% default threshold) — the
    // offset is explicit and documented, the base price is the real captured number.
    // tick() appends a fresh spotPrice sample before evaluating the breakout, so two
    // history samples are seeded here and the third comes from `market.spotPrices`.
    const base = AAPL.priceUsd
    const momentum = new Momentum({ breakoutPct: 0.15, lookbackSamples: 3, entryUsdg: 10 })
    const market = new FakeMarket()
    const now = 10_000
    seededHistory(
      momentum,
      TOKEN_A,
      'AAPL-SIM',
      [
        { ts: now - 2000, priceUsd: base },
        { ts: now - 1000, priceUsd: base * 1.08 },
      ],
      now,
    )
    market.spotPrices.set(TOKEN_A.toLowerCase(), base * 1.2) // appended by tick() as the 3rd sample
    const decision = await momentum.tick(ctxFor(market, [], now, 'usdg'))
    expect(decision.intents).toHaveLength(1)
    expect(decision.intents[0]?.side).toBe('buy')
    expect(decision.intents[0]?.reason).toMatch(/breakout/)
  })

  it('does not enter when the move is under the breakout threshold', async () => {
    const base = AAPL.priceUsd
    const momentum = new Momentum({ breakoutPct: 0.15, lookbackSamples: 3 })
    const market = new FakeMarket()
    const now = 10_000
    seededHistory(
      momentum,
      TOKEN_A,
      'AAPL-SIM',
      [
        { ts: now - 3000, priceUsd: base },
        { ts: now - 2000, priceUsd: base * 1.02 },
        { ts: now - 1000, priceUsd: base * 1.05 }, // only +5%, under 15% threshold
      ],
      now,
    )
    market.spotPrices.set(TOKEN_A.toLowerCase(), base * 1.05)
    const decision = await momentum.tick(ctxFor(market, [], now, 'usdg'))
    expect(decision.intents).toHaveLength(0)
  })

  it('exits on a trailing-stop drawdown from the post-entry peak', async () => {
    const momentum = new Momentum({ trailingStopPct: 0.2 })
    const market = new FakeMarket()
    const now = 100_000
    const pos = position({
      token: TOKEN_A,
      tokenSymbol: 'AAPL-SIM',
      quoteToken: USDG,
      quoteSymbol: 'USDG',
      openedAt: 0,
    })
    // Seed a peak above current spot, then quote a price 25% below it (over the 20% stop).
    ;(momentum as unknown as { peakSinceEntry: Map<string, number> }).peakSinceEntry.set(
      TOKEN_A.toLowerCase(),
      100,
    )
    market.spotPrices.set(TOKEN_A.toLowerCase(), 74) // 26% off the peak of 100
    const decision = await momentum.tick(ctxFor(market, [pos], now, 'usdg'))
    expect(decision.intents.some((i) => i.side === 'sell' && /trailing stop/.test(i.reason))).toBe(true)
  })

  it('reports its edge hypothesis and failure modes (documentation contract)', () => {
    const momentum = new Momentum()
    expect(momentum.meta.edge.length).toBeGreaterThan(20)
    expect(momentum.meta.failureModes.length).toBeGreaterThanOrEqual(3)
  })
})

describe('PremiumWatch — alerts-only by default, eligibility-gated trading', () => {
  it('alerts on a spread that clears the threshold but does NOT trade when enableTrading is false (default)', async () => {
    const watch = new PremiumWatch({
      symbols: ['AAPL'],
      alertThresholdBps: 50,
      tradeThresholdBps: 150,
      enableTrading: false,
    })
    const market = new FakeMarket()
    const oracleUsd = AAPL.priceUsd
    market.chainlinkPrices.set('AAPL', {
      symbol: 'AAPL',
      address: AAPL.address,
      feed: AAPL.address,
      priceUsd: oracleUsd,
      answer: BigInt(Math.round(oracleUsd * 1e8)),
      answerDecimals: 8,
      roundId: 1n,
      updatedAt: 0,
      ageSeconds: 0,
    })
    // DEX 3% below oracle — a real discount magnitude, well over both thresholds.
    market.dexPrices.set(AAPL.address.toLowerCase(), oracleUsd * 0.97)
    const decision = await watch.tick(ctxFor(market, [], Date.now(), 'usdg'))
    expect(decision.intents).toHaveLength(0) // never trades by default
    expect(decision.alerts.some((a) => /discount/.test(a.message))).toBe(true)
  })

  it('trades the convergence only when BOTH enableTrading=true AND the client acknowledged eligibility', async () => {
    const watch = new PremiumWatch({
      symbols: ['AAPL'],
      tradeThresholdBps: 150,
      tradeSizeUsdg: 20,
      enableTrading: true,
    })
    const market = new FakeMarket()
    market.client.acknowledgeStockTokenEligibility = true
    const oracleUsd = AAPL.priceUsd
    market.chainlinkPrices.set('AAPL', {
      symbol: 'AAPL',
      address: AAPL.address,
      feed: AAPL.address,
      priceUsd: oracleUsd,
      answer: BigInt(Math.round(oracleUsd * 1e8)),
      answerDecimals: 8,
      roundId: 1n,
      updatedAt: 0,
      ageSeconds: 0,
    })
    market.dexPrices.set(AAPL.address.toLowerCase(), oracleUsd * 0.97) // 3% discount, over 1.5% threshold
    const decision = await watch.tick(ctxFor(market, [], Date.now(), 'usdg'))
    expect(decision.intents).toHaveLength(1)
    expect(decision.intents[0]?.side).toBe('buy')
    expect(decision.intents[0]?.tokenSymbol).toBe('AAPL')
  })

  it('stays alerts-only when enableTrading=true but eligibility was NOT acknowledged', async () => {
    const watch = new PremiumWatch({ symbols: ['AAPL'], tradeThresholdBps: 150, enableTrading: true })
    const market = new FakeMarket()
    market.client.acknowledgeStockTokenEligibility = false // operator never affirmed
    const oracleUsd = AAPL.priceUsd
    market.chainlinkPrices.set('AAPL', {
      symbol: 'AAPL',
      address: AAPL.address,
      feed: AAPL.address,
      priceUsd: oracleUsd,
      answer: BigInt(Math.round(oracleUsd * 1e8)),
      answerDecimals: 8,
      roundId: 1n,
      updatedAt: 0,
      ageSeconds: 0,
    })
    market.dexPrices.set(AAPL.address.toLowerCase(), oracleUsd * 0.95)
    const decision = await watch.tick(ctxFor(market, [], Date.now(), 'usdg'))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts.some((a) => /eligibility/.test(a.message))).toBe(true)
  })

  it('exits a convergence position once the spread reverts within the exit band', async () => {
    const watch = new PremiumWatch({ symbols: ['AAPL'], exitThresholdBps: 20 })
    const market = new FakeMarket()
    const oracleUsd = AAPL.priceUsd
    market.chainlinkPrices.set('AAPL', {
      symbol: 'AAPL',
      address: AAPL.address,
      feed: AAPL.address,
      priceUsd: oracleUsd,
      answer: BigInt(Math.round(oracleUsd * 1e8)),
      answerDecimals: 8,
      roundId: 1n,
      updatedAt: 0,
      ageSeconds: 0,
    })
    market.dexPrices.set(AAPL.address.toLowerCase(), oracleUsd * 0.9999) // ~1bps spread — converged
    const pos = position({
      token: AAPL.address,
      tokenSymbol: 'AAPL',
      quoteToken: USDG,
      quoteSymbol: 'USDG',
      openedAt: 0,
    })
    const decision = await watch.tick(ctxFor(market, [pos], 60_000, 'usdg'))
    expect(decision.intents.some((i) => i.side === 'sell' && /converged/.test(i.reason))).toBe(true)
  })

  it('reports its edge hypothesis and failure modes, including the no-shorting asymmetry (documentation contract)', () => {
    const watch = new PremiumWatch()
    expect(watch.meta.edge.length).toBeGreaterThan(20)
    expect(watch.meta.failureModes.some((f) => /short/i.test(f))).toBe(true)
  })
})
