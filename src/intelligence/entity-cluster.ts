import type { Address } from 'viem'

export interface EntityClusterOptions {
  /**
   * A funder that has funded more than this many DISTINCT wallets is treated
   * as public infrastructure (a CEX hot wallet, a faucet, an airdrop
   * distributor, a router) rather than evidence of common ownership, and
   * contributes NO clustering signal at all — this is what keeps "10 wallets
   * airdropped by the same project wallet" and "50 wallets withdrawing from
   * the same CEX" from collapsing into one giant false entity.
   *
   * Evaluated on the funder's CURRENT total fan-out at query time, not
   * fan-out-at-time-of-edge: a funder that looked like a normal 1:1 funder
   * for its first 5 wallets and only later turns out to be a mass
   * distributor has ALL of its edges excluded once it crosses the
   * threshold — including the earlier ones. Real-world fan-out isn't known
   * until enough of it has been observed, so retroactive correction here is
   * the accurate behavior, not a bug — see entity-cluster.test.ts's
   * "crossing the threshold" case. @defaultValue 5
   */
  maxFunderFanOut: number
}

const DEFAULT_OPTIONS: EntityClusterOptions = { maxFunderFanOut: 5 }

interface Edge {
  funder: string
  wallet: string
}

/**
 * Union-find over wallet addresses, built from funding edges. Unions are
 * recomputed from the full edge list whenever the graph changes (`dirty`
 * flag) rather than applied eagerly and irreversibly — see
 * `EntityClusterOptions.maxFunderFanOut`'s doc comment for why eager,
 * one-way unions would get the airdrop/CEX exclusion wrong.
 */
export class EntityCluster {
  private readonly edges: Edge[] = []
  private readonly fundedBy = new Map<string, Set<string>>() // funder -> distinct wallets it has funded
  private parent = new Map<string, string>()
  private rank = new Map<string, number>()
  private dirty = false
  private readonly opts: EntityClusterOptions

  constructor(opts: Partial<EntityClusterOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  /** Record that `funder` sent capital to `wallet`. */
  recordFunding(funder: Address, wallet: Address): void {
    const funderKey = funder.toLowerCase()
    const walletKey = wallet.toLowerCase()
    let funded = this.fundedBy.get(funderKey)
    if (!funded) {
      funded = new Set()
      this.fundedBy.set(funderKey, funded)
    }
    if (!funded.has(walletKey)) {
      funded.add(walletKey)
      this.edges.push({ funder: funderKey, wallet: walletKey })
      this.dirty = true
    }
  }

  /** Direct wallet A -> wallet B transfer between two already-tracked wallets. Same fan-out guard as `recordFunding`. */
  recordDirectTransfer(from: Address, to: Address): void {
    this.recordFunding(from, to)
  }

  /** Whether a funder is currently over the fan-out exclusion threshold (public infra, not a clustering signal). */
  isPublicInfra(funder: Address): boolean {
    return (this.fundedBy.get(funder.toLowerCase())?.size ?? 0) > this.opts.maxFunderFanOut
  }

  /** The entity ID (union-find root) for a wallet — a lowercase address, either the wallet's own or a shared root. */
  entityOf(wallet: Address): string {
    this.rebuildIfDirty()
    return this.find(wallet.toLowerCase())
  }

  /** Count of distinct entities among a set of wallets — the spec's "independent_entity_count". */
  independentEntityCount(wallets: readonly Address[]): number {
    this.rebuildIfDirty()
    return new Set(wallets.map((w) => this.find(w.toLowerCase()))).size
  }

  private rebuildIfDirty(): void {
    if (!this.dirty) return
    this.parent = new Map()
    this.rank = new Map()
    for (const edge of this.edges) {
      if (this.isPublicInfra(edge.funder as Address)) continue // excluded — see maxFunderFanOut's doc comment
      this.union(edge.funder, edge.wallet)
    }
    this.dirty = false
  }

  private find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      this.rank.set(x, 0)
      return x
    }
    let root = this.parent.get(x)!
    if (root !== x) {
      root = this.find(root)
      this.parent.set(x, root) // path compression
    }
    return root
  }

  private union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    const rankA = this.rank.get(ra) ?? 0
    const rankB = this.rank.get(rb) ?? 0
    if (rankA < rankB) {
      this.parent.set(ra, rb)
    } else if (rankA > rankB) {
      this.parent.set(rb, ra)
    } else {
      this.parent.set(rb, ra)
      this.rank.set(ra, rankA + 1)
    }
  }
}
