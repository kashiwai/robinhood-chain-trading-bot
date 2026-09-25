import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { parseEther } from 'viem'
import type { HoodClient } from 'hoodchain'
import { evaluateCandidate } from '../../src/decision/candidate-evaluator.js'
import { WalletStore } from '../../src/intelligence/wallet-store.js'
import { EntityCluster } from '../../src/intelligence/entity-cluster.js'
import { FakeMarket } from './helpers/fake-market.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as Address
const WETH = '0x2222222222222222222222222222222222222b' as Address
const BUYER = '0x3333333333333333333333333333333333333c' as Address

function fakeClient(): HoodClient {
  return {
    public: {
      getCode: async () => '0x6080604052',
      getStorageAt: async () => `0x${'0'.repeat(64)}`,
      readContract: async () => {
        throw new Error('no owner()')
      },
      call: async () => {
        throw new Error('reverted')
      },
    },
  } as unknown as HoodClient
}

describe('evaluateCandidate — end-to-end orchestration', () => {
  it('assembles a real FeatureVector from Level 5 + Level 3/4 signals and runs the ensemble', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.0098'))

    const walletStore = new WalletStore(':memory:')
    walletStore.recordTrade({
      token: TOKEN,
      wallet: BUYER,
      side: 'buy',
      amountTokenWei: '1000',
      amountUsd: 50,
      mcapUsd: 100_000,
      blockNumber: 1n,
      transactionHash: '0xabc',
      logIndex: 0,
      ts: Date.now(),
      secondsSinceLaunch: 30,
    })

    const entityCluster = new EntityCluster()

    const result = await evaluateCandidate(
      {
        token: TOKEN,
        quoteToken: WETH,
        tokenAgeSeconds: 45,
        ensembleOptions: { liveMode: 'RULE', jevAdapter: null },
      },
      {
        client: fakeClient(),
        market,
        walletStore,
        entityCluster,
        probeAmountIn: parseEther('0.01'),
      },
    )

    expect(result.featureVector.token_age_seconds).toBe(45)
    expect(result.featureVector.contract_risk).toBe(0) // clean fake bytecode, no owner, no mint selector
    expect(result.featureVector.buy_pressure).toBeCloseTo(50, 6) // the one recorded buy, within the window
    expect(result.ensemble.results).toHaveLength(5)
    expect(result.ensemble.liveMode).toBe('RULE')

    walletStore.close()
  })

  it('a token with no wallet activity at all still produces a valid (zeroed) feature vector, not a crash', async () => {
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN.toLowerCase(), parseEther('0.0098'))
    const walletStore = new WalletStore(':memory:')
    const entityCluster = new EntityCluster()

    const result = await evaluateCandidate(
      {
        token: TOKEN,
        quoteToken: WETH,
        tokenAgeSeconds: 10,
        ensembleOptions: { liveMode: 'RULE', jevAdapter: null },
      },
      { client: fakeClient(), market, walletStore, entityCluster, probeAmountIn: parseEther('0.01') },
    )

    expect(result.featureVector.smart_wallet_count).toBe(0)
    expect(result.featureVector.buy_pressure).toBe(0)
    expect(result.ensemble.liveResult).toBeDefined()

    walletStore.close()
  })
})
