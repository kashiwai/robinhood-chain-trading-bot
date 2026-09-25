import { erc20Abi, type HoodClient } from 'hoodchain'
import type { Address } from 'viem'

export interface FundingEdge {
  funder: Address
  wallet: Address
  token: Address
  amountWei: bigint
  blockNumber: bigint
}

/**
 * Finds who funded a wallet's trading activity: the earliest inbound
 * WETH/USDG transfer to that wallet within the lookback window. Uses
 * `getLogs` filtered on the indexed `to` topic — cheap (an indexed-topic
 * filter, not a full-chain scan), but only sees funding that happened within
 * `lookbackBlocks` of the query, so a wallet funded further back reads as
 * "no funder found" rather than incorrectly independent — documented
 * limitation, not silently wrong.
 */
export async function resolveFunder(
  client: HoodClient,
  wallet: Address,
  quoteTokens: readonly Address[],
  lookbackBlocks = 500_000n,
): Promise<FundingEdge | null> {
  const latest = await client.public.getBlockNumber()
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n

  let earliest: FundingEdge | null = null
  for (const token of quoteTokens) {
    const logs = await client.public.getContractEvents({
      address: token,
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { to: wallet },
      fromBlock,
      toBlock: latest,
    })
    for (const log of logs) {
      if (!log.args.from || log.args.value === undefined) continue
      if (log.args.from.toLowerCase() === wallet.toLowerCase()) continue // self-funding artifact, ignore
      if (earliest === null || log.blockNumber < earliest.blockNumber) {
        earliest = {
          funder: log.args.from,
          wallet,
          token,
          amountWei: log.args.value,
          blockNumber: log.blockNumber,
        }
      }
    }
  }
  return earliest
}
