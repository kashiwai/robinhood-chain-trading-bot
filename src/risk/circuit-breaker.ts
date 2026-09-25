export type BreakerCondition =
  | 'rpc_unhealthy'
  | 'database_error'
  | 'sell_failure'
  | 'daily_loss_exceeded'
  | 'drawdown_exceeded'
  | 'consecutive_losses'
  | 'price_oracle_disagreement'
  | 'nonce_failure'
  | 'reconciliation_mismatch'

export interface TrippedBreaker {
  condition: BreakerCondition
  detail: string
  trippedAt: number
}

/**
 * The spec's nine named circuit breakers. Tripping ANY of them pauses NEW
 * BUYS only — sells are never blocked here (see the class's `buyPaused`
 * naming; there is deliberately no `sellPaused`). A position already open
 * when something goes wrong must still be closable; refusing to let it sell
 * because (say) the RPC endpoint is flaky would trap risk instead of
 * shedding it — the same "sells are exempt" principle
 * {@link ../framework/risk.js!RiskEngine} and
 * {@link ./account-risk.js!checkAccountRisk} already apply, now for
 * operational conditions instead of spend/exposure ones.
 *
 * Each condition trips independently and stays tripped until explicitly
 * cleared — callers decide per-condition whether "cleared" means "the RPC
 * came back healthy" (transient, checked every health-check tick — see
 * main.ts's RpcManager wiring) or "a human reviewed it" (sticky, e.g.
 * reconciliation_mismatch). This class has no opinion on which; it just
 * tracks trip/clear calls it's given.
 */
export class CircuitBreaker {
  private readonly tripped = new Map<BreakerCondition, TrippedBreaker>()
  private readonly listeners = new Set<(t: TrippedBreaker) => void>()

  trip(condition: BreakerCondition, detail: string, now = Date.now()): void {
    const wasTripped = this.tripped.has(condition)
    const entry: TrippedBreaker = { condition, detail, trippedAt: now }
    this.tripped.set(condition, entry)
    if (!wasTripped) {
      for (const l of this.listeners) {
        try {
          l(entry)
        } catch {
          // a listener throwing must not stop the others from being notified
        }
      }
    }
  }

  clear(condition: BreakerCondition): void {
    this.tripped.delete(condition)
  }

  isTripped(condition: BreakerCondition): boolean {
    return this.tripped.has(condition)
  }

  /** True the instant ANY condition is tripped — the gate `Agent`/`Fleet` check before allowing a new buy. */
  buyPaused(): boolean {
    return this.tripped.size > 0
  }

  activeConditions(): TrippedBreaker[] {
    return [...this.tripped.values()]
  }

  onTrip(listener: (t: TrippedBreaker) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
