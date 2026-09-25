import type { TradeRecord } from '../framework/types.js'

export interface PerformanceReport {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  avgWinUsd: number
  avgLossUsd: number
  /** Average $ won/lost per trade, win or lose — the number that actually tells you if the strategy is worth running. */
  expectancyUsd: number
  profitFactor: number
  realizedPnlUsd: number
  maxDrawdownUsd: number
  /** Mean / stdev of per-trade realized PnL — NOT annualized, NOT risk-free-rate adjusted; a same-units relative consistency measure only. See the doc comment below. */
  sharpeLike: number
  totalGasEstimate: bigint
  avgSlippageBps: number
  sellFailureRate: number
  probeFailureRate: number
}

export interface SellFailureInput {
  totalSellAttempts: number
  failedSells: number
}

export interface ProbeFailureInput {
  totalProbes: number
  failedProbes: number
}

interface Lot {
  tokenAmount: bigint
  costUsd: number
}

/**
 * Standard trading metrics computed from real journaled trades — no field
 * here is a placeholder. Realized PnL uses FIFO cost-basis matching per
 * (agentId, token), the same approach wallet-store.ts uses for wallet PnL,
 * applied here to this bot's OWN trades instead. USD notional comes from
 * `TradeRecord.meta.notionalUsd`, already computed by Agent at fill time
 * from a live quote (agent.ts) — not re-derived from a stale price.
 *
 * `sharpeLike` is named that deliberately, not "sharpeRatio": a real Sharpe
 * ratio needs a risk-free rate and an annualization period; this is just
 * mean(perTradePnl) / stdev(perTradePnl) — a same-units measure of how
 * consistent the per-trade result is, useful for comparing two strategies
 * against EACH OTHER, not as a standalone finance-textbook Sharpe figure.
 */
export function computePerformance(
  trades: readonly TradeRecord[],
  sellFailures: SellFailureInput = { totalSellAttempts: 0, failedSells: 0 },
  probeFailures: ProbeFailureInput = { totalProbes: 0, failedProbes: 0 },
): PerformanceReport {
  const lots = new Map<string, Lot[]>() // key: `${agentId}:${token}`
  const perTradePnl: number[] = []
  let grossWin = 0
  let grossLoss = 0
  let wins = 0
  let losses = 0
  let totalGas = 0n
  let slippageSum = 0
  let slippageCount = 0
  let equity = 0
  let peak = 0
  let maxDrawdown = 0

  const sorted = [...trades].sort((a, b) => a.ts - b.ts)
  for (const t of sorted) {
    const key = `${t.agentId}:${t.token.toLowerCase()}`
    const notionalUsd = typeof t.meta.notionalUsd === 'number' ? t.meta.notionalUsd : 0
    totalGas += t.gasEstimate
    slippageSum += t.slippageBps
    slippageCount++

    if (t.side === 'buy') {
      const list = lots.get(key) ?? []
      list.push({ tokenAmount: t.amountOut, costUsd: notionalUsd })
      lots.set(key, list)
      continue
    }

    // sell: FIFO-match against open lots for this (agent, token)
    let remaining = t.amountIn
    const totalSoldWei = remaining
    let realized = 0
    const list = lots.get(key) ?? []
    while (remaining > 0n && list.length > 0) {
      const lot = list[0]!
      const consume = lot.tokenAmount < remaining ? lot.tokenAmount : remaining
      const fraction = lot.tokenAmount > 0n ? Number(consume) / Number(lot.tokenAmount) : 0
      const costOfConsumed = lot.costUsd * fraction
      const saleFraction = totalSoldWei > 0n ? Number(consume) / Number(totalSoldWei) : 0
      realized += notionalUsd * saleFraction - costOfConsumed
      lot.tokenAmount -= consume
      lot.costUsd -= costOfConsumed
      remaining -= consume
      if (lot.tokenAmount <= 0n) list.shift()
    }

    perTradePnl.push(realized)
    if (realized > 0) {
      wins++
      grossWin += realized
    } else if (realized < 0) {
      losses++
      grossLoss += -realized
    }
    equity += realized
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }

  const totalClosedTrades = wins + losses
  const winRate = totalClosedTrades > 0 ? wins / totalClosedTrades : 0
  const avgWinUsd = wins > 0 ? grossWin / wins : 0
  const avgLossUsd = losses > 0 ? grossLoss / losses : 0
  const expectancyUsd = totalClosedTrades > 0 ? (grossWin - grossLoss) / totalClosedTrades : 0
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0

  const mean = perTradePnl.length > 0 ? perTradePnl.reduce((s, p) => s + p, 0) / perTradePnl.length : 0
  const variance =
    perTradePnl.length > 0 ? perTradePnl.reduce((s, p) => s + (p - mean) ** 2, 0) / perTradePnl.length : 0
  const stdev = Math.sqrt(variance)
  const sharpeLike = stdev > 0 ? mean / stdev : 0

  return {
    totalTrades: trades.length,
    winningTrades: wins,
    losingTrades: losses,
    winRate,
    avgWinUsd,
    avgLossUsd,
    expectancyUsd,
    profitFactor,
    realizedPnlUsd: grossWin - grossLoss,
    maxDrawdownUsd: maxDrawdown,
    sharpeLike,
    totalGasEstimate: totalGas,
    avgSlippageBps: slippageCount > 0 ? slippageSum / slippageCount : 0,
    sellFailureRate:
      sellFailures.totalSellAttempts > 0 ? sellFailures.failedSells / sellFailures.totalSellAttempts : 0,
    probeFailureRate:
      probeFailures.totalProbes > 0 ? probeFailures.failedProbes / probeFailures.totalProbes : 0,
  }
}
