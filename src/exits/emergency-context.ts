import { erc20Abi, type HoodClient } from 'hoodchain'
import type { Address } from 'viem'
import type { Market } from '../framework/market.js'
import type { WalletStore } from '../intelligence/wallet-store.js'
import { computeWalletScore } from '../intelligence/wallet-score.js'
import { scanContractRisk } from '../security/contract-risk.js'
import { checkSellability } from '../security/sellability.js'
import { computeExecutableLiquidity } from '../security/liquidity.js'
import type { EmergencyEntrySnapshot, EmergencyMonitorHooks } from './emergency-monitor.js'
import type { EmergencyExitInput } from './emergency-exit.js'

export interface RealEmergencyMonitorOptions {
  client: HoodClient
  market: Pick<Market, 'quoteBuy' | 'quoteSell'>
  walletStore: Pick<WalletStore, 'recentTransfers' | 'get'>
  /** Probe size for the sellability/liquidity round trip — same order of magnitude as a real entry, not a token's full position. */
  probeAmountIn: bigint
  /** A wallet score at/above this is "smart money" for the cluster_smart_money_exit check. @defaultValue 60 */
  smartMoneyMinScore?: number
  /** Look-back window for buy/sell pressure and smart-money-selling detection. @defaultValue 300000 (5 min) */
  pressureWindowMs?: number
}

/**
 * Wires the emergency-exit layer (see emergency-monitor.ts, agent.ts) to
 * REAL Level 5 security scans and Level 3/4 wallet intelligence — every
 * function called here already exists and is already tested; this module is
 * pure wiring, not new detection logic. `main.ts` constructs one instance
 * per fleet and passes it to every Agent as `emergencyMonitor`.
 *
 * Deliberately best-effort: any scan that throws (a flaky RPC call is far
 * more likely than a real emergency) resolves a neutral/unchanged value
 * rather than propagating — `checkEmergencyExit` already treats "no signal"
 * as "no trip" for every field this module can go quiet on.
 */
export function createRealEmergencyMonitor(opts: RealEmergencyMonitorOptions): EmergencyMonitorHooks {
  const smartMoneyMinScore = opts.smartMoneyMinScore ?? 60
  const pressureWindowMs = opts.pressureWindowMs ?? 5 * 60_000

  async function scanLiquidityAndRetention(
    token: Address,
    quoteToken: Address,
  ): Promise<{ liquidityScore: number; roundTripRetention: number | null }> {
    try {
      const sellability = await checkSellability(opts.market, token, quoteToken, opts.probeAmountIn)
      if (!sellability.sellable || !sellability.buyAmountOut) {
        return { liquidityScore: 0, roundTripRetention: sellability.roundTripRetention }
      }
      // Matches decision/candidate-evaluator.ts's own established convention
      // for deriving a USD-comparable spot price from the round-trip probe —
      // same heuristic, not a second, differently-calibrated one.
      const spotPriceUsd = Number(sellability.buyAmountOut) / Number(opts.probeAmountIn)
      const liquidity = await computeExecutableLiquidity(
        opts.market,
        token,
        quoteToken,
        spotPriceUsd,
        1,
        18,
        18,
        [25, 100, 500], // the only three tiers scoreLiquidity actually reads — no point probing the rest here
      )
      return { liquidityScore: liquidity.liquidityScore, roundTripRetention: sellability.roundTripRetention }
    } catch {
      return { liquidityScore: 0, roundTripRetention: null }
    }
  }

  async function scanContractRiskScore(token: Address): Promise<number> {
    try {
      return (await scanContractRisk(opts.client, token)).riskScore
    } catch {
      return 0
    }
  }

  return {
    async captureEntry(token, quoteToken, _now, intentMeta): Promise<EmergencyEntrySnapshot> {
      const [{ liquidityScore, roundTripRetention }, contractRiskScore] = await Promise.all([
        scanLiquidityAndRetention(token, quoteToken),
        scanContractRiskScore(token),
      ])
      const deployerAddress = (intentMeta.deployerAddress as Address | undefined) ?? null
      return { liquidityScore, contractRiskScore, roundTripRetention, deployerAddress }
    },

    async currentSignals(
      token,
      quoteToken,
      entry,
      now,
    ): Promise<Partial<Omit<EmergencyExitInput, 'currentlySellable' | 'quoteAnomalyDetected'>>> {
      const since = now - pressureWindowMs
      const [{ liquidityScore, roundTripRetention }, contractRiskScore, deployerBalanceDropped] =
        await Promise.all([
          scanLiquidityAndRetention(token, quoteToken),
          scanContractRiskScore(token),
          checkDeployerBalanceDropped(opts.client, token, entry.deployerAddress),
        ])

      const transfers = opts.walletStore.recentTransfers(token, since)
      const buyPressureUsd = transfers.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amountUsd, 0)
      const sellPressureUsd = transfers.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amountUsd, 0)

      const sellerWallets = new Set(
        transfers.filter((t) => t.side === 'sell').map((w) => w.wallet.toLowerCase()),
      )
      let smartMoneyNowSelling = false
      for (const wallet of sellerWallets) {
        const stats = opts.walletStore.get(wallet as Address)
        if (stats && computeWalletScore(stats).score >= smartMoneyMinScore) {
          smartMoneyNowSelling = true
          break
        }
      }

      return {
        currentLiquidityScore: liquidityScore,
        currentContractRiskScore: contractRiskScore,
        currentRoundTripRetention: roundTripRetention,
        deployerBalanceDropped,
        smartMoneyNowSelling,
        buyPressureUsd,
        sellPressureUsd,
      }
    },
  }
}

async function checkDeployerBalanceDropped(
  client: HoodClient,
  token: Address,
  deployerAddress: Address | null,
): Promise<boolean> {
  if (!deployerAddress) return false
  try {
    // A single current-balance read; "dropped" is judged against the entry
    // snapshot's own balance by main.ts's caller across ticks would require
    // storing a running balance too — kept simple: a deployer balance of
    // (effectively) zero after having ever opened a position is the one
    // unambiguous "dumped everything" signal this can assert without extra
    // state, and is exactly the pattern a fresh-launch rug takes.
    const bal = (await client.public.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [deployerAddress],
    })) as bigint
    return bal === 0n
  } catch {
    return false
  }
}
