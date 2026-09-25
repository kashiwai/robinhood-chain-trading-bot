import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { HoodClient } from 'hoodchain'
import type { Market, SpotPrice } from '../../src/framework/market.js'
import { WalletStore } from '../../src/intelligence/wallet-store.js'
import { dexAddressesForToken, WalletTracker } from '../../src/intelligence/wallet-tracker.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const POOL = '0x2222222222222222222222222222222222222b' as Address
const WALLET_A = '0x3333333333333333333333333333333333333c' as Address
const WALLET_B = '0x4444444444444444444444444444444444444d' as Address

interface FakeLog {
  args: { from: Address; to: Address; value: bigint }
  blockNumber: bigint
  transactionHash: string
  logIndex: number
}

function fakeClient(opts: { latest: bigint; logs: FakeLog[]; totalSupply: bigint }): HoodClient {
  return {
    public: {
      getBlockNumber: async () => opts.latest,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        opts.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
      readContract: async () => opts.totalSupply,
      // watchTransfers (hoodchain) subscribes via watchContractEvent at call
      // time — stub it as a no-op poller so `track()`'s live-watch leg can
      // wire up without a real chain connection. This test only exercises
      // the deterministic backfill path; see the class doc comment for why
      // the live-watch path isn't separately unit-tested here.
      watchContractEvent: () => () => {},
    },
  } as unknown as HoodClient
}

function fakeMarket(priceUsd: number): Pick<Market, 'spotPrice'> {
  return {
    spotPrice: async (token: Address): Promise<SpotPrice | null> => ({
      token,
      priceUsd,
      via: 'usdg',
      ts: Date.now(),
    }),
  }
}

describe('WalletTracker.backfill — the RPC-read -> decode -> DB-transaction -> commit -> cursor-update order', () => {
  it('classifies and records trades from a fresh backfill, then advances the cursor to the latest scanned block', async () => {
    const store = new WalletStore(':memory:')
    const logs: FakeLog[] = [
      // buy: pool -> WALLET_A
      {
        args: { from: POOL, to: WALLET_A, value: 100n },
        blockNumber: 10n,
        transactionHash: '0xa',
        logIndex: 0,
      },
      // sell: WALLET_A -> pool
      {
        args: { from: WALLET_A, to: POOL, value: 40n },
        blockNumber: 12n,
        transactionHash: '0xb',
        logIndex: 0,
      },
      // plain transfer: WALLET_A -> WALLET_B — must NOT be recorded as a trade
      {
        args: { from: WALLET_A, to: WALLET_B, value: 5n },
        blockNumber: 13n,
        transactionHash: '0xc',
        logIndex: 0,
      },
    ]
    const client = fakeClient({ latest: 20n, logs, totalSupply: 1_000_000n * 10n ** 18n })
    const market = fakeMarket(2) // $2/token

    const tracker = new WalletTracker({ client, market, store, chainId: 4663 })
    const dexAddresses = dexAddressesForToken(POOL, [])
    // Directly exercise the backfill path (private, but the class's only
    // externally-triggerable entry is `track`, which also spins up a live
    // `watchTransfers` subscription we don't want running in a unit test —
    // so we reach the same code path through `track` and immediately stop it).
    await tracker.track({ token: TOKEN, dexAddresses, launchDetectedAtMs: null })
    tracker.stop()

    const stats = store.get(WALLET_A)!
    expect(stats.totalTrades).toBe(2) // buy + sell; the wallet->wallet transfer is excluded
    // fakeMarket prices every call identically ($2/token), so this round trip
    // (buy 100, sell 40 = 40% of the lot) is exactly breakeven: cost for the
    // 40% consumed = 0.4 * $200 = $80, proceeds = 40 * $2 = $80. FIFO/PnL
    // math itself is exhaustively covered in wallet-store.test.ts; this test
    // is about classification + cursor advancement, not PnL correctness.
    expect(stats.realizedPnlUsd).toBeCloseTo(0, 6)
    expect(store.cursorFor(TOKEN)).toBe(20n)

    // Nothing recorded for the plain wallet->wallet transfer.
    expect(store.get(WALLET_B)).toBeNull()
  })

  it('a second backfill from the persisted cursor does not double-count already-seen trades', async () => {
    const store = new WalletStore(':memory:')
    const logs: FakeLog[] = [
      {
        args: { from: POOL, to: WALLET_A, value: 100n },
        blockNumber: 10n,
        transactionHash: '0xa',
        logIndex: 0,
      },
    ]
    const client = fakeClient({ latest: 15n, logs, totalSupply: 1_000_000n * 10n ** 18n })
    const market = fakeMarket(1)
    const dexAddresses = dexAddressesForToken(POOL, [])

    const tracker1 = new WalletTracker({ client, market, store, chainId: 4663 })
    await tracker1.track({ token: TOKEN, dexAddresses, launchDetectedAtMs: null })
    tracker1.stop()
    expect(store.get(WALLET_A)?.totalTrades).toBe(1)

    // Simulate a restart: a fresh tracker instance against the same store/cursor.
    const client2 = fakeClient({ latest: 15n, logs, totalSupply: 1_000_000n * 10n ** 18n })
    const tracker2 = new WalletTracker({ client: client2, market, store, chainId: 4663 })
    await tracker2.track({ token: TOKEN, dexAddresses, launchDetectedAtMs: null })
    tracker2.stop()

    // fromBlock is cursor+1 = 16, past the log at block 10, so nothing new is
    // scanned — and even if the same block range were rescanned, recordTrade's
    // idempotency (see wallet-store.test.ts) would prevent a double-count.
    expect(store.get(WALLET_A)?.totalTrades).toBe(1)
  })

  it('dexAddressesForToken includes the pool and every shared-infra address, lowercased', () => {
    const router = '0x5555555555555555555555555555555555555e' as Address
    const set = dexAddressesForToken(POOL, [router])
    expect(set.has(POOL.toLowerCase())).toBe(true)
    expect(set.has(router.toLowerCase())).toBe(true)
    expect(set.size).toBe(2)
  })

  it('dexAddressesForToken tolerates a null pool (e.g. an un-graduated Odyssey token)', () => {
    const set = dexAddressesForToken(null, [])
    expect(set.size).toBe(0)
  })
})
