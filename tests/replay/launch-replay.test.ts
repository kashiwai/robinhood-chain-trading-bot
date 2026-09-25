/**
 * Level 2 acceptance: replay 1000 synthetic launch events through the real
 * discovery pipeline (EventQueue -> ReorgGuard -> LaunchSniper) and assert
 * `lost events = 0` and `duplicate orders = 0` — the two numbers the spec
 * calls out explicitly. "Real pipeline" means the actual EventQueue,
 * ReorgGuard, and LaunchSniper classes; only the chain RPC (FakeMarket / a
 * stub HoodClient) and Uniswap liquidity are synthetic. No mocks stand in for
 * the queue's state machine or the strategy's decision logic.
 */
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { parseEther } from 'viem'
import type { HoodClient } from 'hoodchain'
import { EventQueue } from '../../src/discovery/event-queue.js'
import { ReorgGuard } from '../../src/discovery/reorg-guard.js'
import { LAUNCH_KIND, encodeLaunchPayload } from '../../src/discovery/launch-detector.js'
import { LaunchSniper } from '../../src/strategies/launch-sniper.js'
import { FakeMarket } from '../unit/helpers/fake-market.js'
import type { Market } from '../../src/framework/market.js'
import type { StrategyTickContext } from '../../src/framework/strategy.js'

const CHAIN_ID = 4663
const CREATOR = '0x3333333333333333333333333333333333333c' as Address
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address

function addr(i: number): Address {
  return `0x${i.toString(16).padStart(40, '0')}` as Address
}

function txHash(i: number): `0x${string}` {
  return `0x${i.toString(16).padStart(64, '0')}` as `0x${string}`
}

type Outcome = 'tradeable' | 'no-route' | 'honeypot'

function outcomeFor(i: number): Outcome {
  if (i % 10 === 0) return 'no-route' // 10%
  if (i % 7 === 0) return 'honeypot' // ~13%
  return 'tradeable' // the rest
}

describe('Level 2 replay: 1000 launch events through EventQueue + ReorgGuard + LaunchSniper', () => {
  it('loses zero events and produces zero duplicate orders', async () => {
    const N = 1000
    const queue = new EventQueue(':memory:')
    const market = new FakeMarket()
    market.multicallResults = [parseEther('1000'), parseEther('10')] // deployer holds 1% — always clears the cap

    const entryWeth = parseEther('0.01') // LaunchSniper's default `entryWeth` param
    const events: { token: Address; blockNumber: bigint; tx: `0x${string}`; outcome: Outcome }[] = []
    for (let i = 1; i <= N; i++) {
      const token = addr(i)
      const outcome = outcomeFor(i)
      const blockNumber = 1_000_000n + BigInt(i)
      const tx = txHash(i)
      events.push({ token, blockNumber, tx, outcome })

      if (outcome === 'tradeable') {
        market.buyRoutes.set(token.toLowerCase(), parseEther('1000')) // tokens received for the WETH spent
        // Round-trip retention is measured in the quote (WETH) denomination —
        // sell proceeds as a fraction of entryWeth, not of the token amount
        // just bought (see LaunchSniper.evaluate: retention = sellQuote/amountIn).
        market.sellRoutes.set(token.toLowerCase(), (entryWeth * 98n) / 100n) // clean round trip, 2% loss
      } else if (outcome === 'honeypot') {
        market.buyRoutes.set(token.toLowerCase(), parseEther('1000'))
        // no sellRoutes entry -> quoteSell resolves null -> "honeypot" rejection
      }
      // 'no-route': no buyRoutes entry at all
    }

    // ── ingest: every event detected once, plus a redelivery for every 5th
    //    (simulating a watcher restart replaying already-seen logs) ──────────
    let recordedIds = 0
    let duplicateDeliveries = 0
    for (const ev of events) {
      const input = {
        chainId: CHAIN_ID,
        blockNumber: ev.blockNumber,
        transactionHash: ev.tx,
        discriminator: ev.token,
        kind: LAUNCH_KIND,
        payload: encodeLaunchPayload({
          launchpad: 'noxa',
          token: ev.token,
          creator: CREATOR,
          pool: ev.token,
          blockNumber: ev.blockNumber,
          transactionHash: ev.tx,
        }),
      }
      const id = queue.recordDetected(input)
      if (id) recordedIds++
      if (ev.blockNumber % 5n === 0n) {
        const redelivered = queue.recordDetected(input) // identical composite key
        expect(redelivered).toBeNull() // idempotent — must NOT create a second row
        duplicateDeliveries++
      }
    }
    expect(recordedIds).toBe(N)
    expect(duplicateDeliveries).toBeGreaterThan(0) // sanity: we actually exercised the dedup path
    expect(queue.stateCounts(LAUNCH_KIND).detected).toBe(N) // no phantom rows from redelivery

    // ── confirmation gate: promote every event to queued via the real ReorgGuard ──
    const stubClient = {
      public: {
        getBlockNumber: async () => 1_000_000n + BigInt(N) + 10n, // every event is well past 3 confirmations
        getTransactionReceipt: async ({ hash }: { hash: string }) => {
          const ev = events.find((e) => e.tx === hash)
          if (!ev) throw new Error('unknown tx')
          return { blockNumber: ev.blockNumber }
        },
      },
    } as unknown as HoodClient
    const guard = new ReorgGuard({ client: stubClient, queue, kind: LAUNCH_KIND, confirmations: 3 })
    const { promoted, reorged } = await guard.sweep()
    expect(promoted).toBe(N)
    expect(reorged).toBe(0)
    expect(queue.stateCounts(LAUNCH_KIND).queued).toBe(N)

    // ── drain: LaunchSniper claims + evaluates one event per tick, exactly
    //    like production (main.ts ticks each agent on an interval) ──────────
    const sniper = new LaunchSniper({}, queue)
    const seenBuyTokens: Address[] = []
    let ticks = 0
    const maxTicks = N + 10 // small slack; must not need more than N claims
    for (; ticks < maxTicks; ticks++) {
      const ctx: StrategyTickContext = {
        market: market as unknown as Market,
        positions: [],
        now: Date.now(),
        quoteToken: WETH,
        quoteSymbol: 'WETH',
        quoteDecimals: 18,
        log: () => {},
      }
      const decision = await sniper.tick(ctx)
      for (const intent of decision.intents) {
        expect(intent.side).toBe('buy')
        seenBuyTokens.push(intent.token)
      }
      if (queue.stateCounts(LAUNCH_KIND).queued === 0) break
    }

    // ── assertions: the two numbers the spec calls out by name ─────────────
    const counts = queue.stateCounts(LAUNCH_KIND)
    expect(counts.detected).toBe(0)
    expect(counts.queued).toBe(0)
    expect(counts.processing).toBe(0)
    const terminal = counts.decisioned + counts.rejected + counts.error + counts.traded
    expect(terminal).toBe(N) // lost events = 0 — every event reached a terminal state

    const uniqueBuyTokens = new Set(seenBuyTokens)
    expect(uniqueBuyTokens.size).toBe(seenBuyTokens.length) // duplicate orders = 0 — no token bought twice

    const expectedTradeable = events.filter((e) => e.outcome === 'tradeable').length
    expect(seenBuyTokens.length).toBe(expectedTradeable)
    expect(counts.decisioned).toBe(expectedTradeable)
    expect(counts.rejected).toBe(N - expectedTradeable)
    expect(counts.error).toBe(0)
  })
})
