import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { HoodClient } from 'hoodchain'
import { resolveFunder } from '../../src/intelligence/funding-graph.js'

const WETH = '0x1111111111111111111111111111111111111a' as Address
const USDG = '0x2222222222222222222222222222222222222b' as Address
const WALLET = '0x3333333333333333333333333333333333333c' as Address
const FUNDER_EARLY = '0x4444444444444444444444444444444444444d' as Address
const FUNDER_LATE = '0x5555555555555555555555555555555555555e' as Address

interface FakeLog {
  args: { from: Address; to: Address; value: bigint }
  blockNumber: bigint
}

function fakeClient(latest: bigint, logsByToken: Map<string, FakeLog[]>): HoodClient {
  return {
    public: {
      getBlockNumber: async () => latest,
      getContractEvents: async ({ address, args }: { address: Address; args: { to: Address } }) => {
        const logs = logsByToken.get(address.toLowerCase()) ?? []
        return logs.filter((l) => l.args.to.toLowerCase() === args.to.toLowerCase())
      },
    },
  } as unknown as HoodClient
}

describe('resolveFunder', () => {
  it('picks the EARLIEST inbound WETH/USDG transfer as the funder', async () => {
    const client = fakeClient(
      1000n,
      new Map([
        [
          WETH.toLowerCase(),
          [
            { args: { from: FUNDER_LATE, to: WALLET, value: 5n }, blockNumber: 200n },
            { args: { from: FUNDER_EARLY, to: WALLET, value: 10n }, blockNumber: 100n }, // earlier block
          ],
        ],
      ]),
    )
    const edge = await resolveFunder(client, WALLET, [WETH, USDG])
    expect(edge?.funder).toBe(FUNDER_EARLY)
    expect(edge?.blockNumber).toBe(100n)
  })

  it('checks across multiple quote tokens and picks the overall earliest', async () => {
    const client = fakeClient(
      1000n,
      new Map([
        [WETH.toLowerCase(), [{ args: { from: FUNDER_LATE, to: WALLET, value: 5n }, blockNumber: 150n }]],
        [USDG.toLowerCase(), [{ args: { from: FUNDER_EARLY, to: WALLET, value: 10n }, blockNumber: 50n }]],
      ]),
    )
    const edge = await resolveFunder(client, WALLET, [WETH, USDG])
    expect(edge?.funder).toBe(FUNDER_EARLY)
    expect(edge?.token).toBe(USDG)
  })

  it('returns null when no inbound transfer is found within the lookback window', async () => {
    const client = fakeClient(1000n, new Map())
    const edge = await resolveFunder(client, WALLET, [WETH, USDG])
    expect(edge).toBeNull()
  })

  it('ignores a self-transfer (from === wallet) as a funding artifact', async () => {
    const client = fakeClient(
      1000n,
      new Map([[WETH.toLowerCase(), [{ args: { from: WALLET, to: WALLET, value: 1n }, blockNumber: 10n }]]]),
    )
    const edge = await resolveFunder(client, WALLET, [WETH])
    expect(edge).toBeNull()
  })
})
