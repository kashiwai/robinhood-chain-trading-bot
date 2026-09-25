import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { EntityCluster } from '../../src/intelligence/entity-cluster.js'

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

describe("EntityCluster — the spec's four fixture categories", () => {
  it('same-owner wallets (shared funder, low fan-out) collapse into ONE entity', () => {
    const cluster = new EntityCluster()
    const funder = addr(1)
    const walletA = addr(2)
    const walletB = addr(3)
    cluster.recordFunding(funder, walletA)
    cluster.recordFunding(funder, walletB)

    expect(cluster.entityOf(walletA)).toBe(cluster.entityOf(walletB))
    expect(cluster.independentEntityCount([walletA, walletB])).toBe(1)
  })

  it('independent wallets (different funders) stay as SEPARATE entities', () => {
    const cluster = new EntityCluster()
    const walletC = addr(10)
    const walletD = addr(11)
    cluster.recordFunding(addr(20), walletC)
    cluster.recordFunding(addr(21), walletD)

    expect(cluster.entityOf(walletC)).not.toBe(cluster.entityOf(walletD))
    expect(cluster.independentEntityCount([walletC, walletD])).toBe(2)
  })

  it('airdrop wallets (one distributor funds many unrelated recipients) do NOT collapse into one entity', () => {
    const cluster = new EntityCluster({ maxFunderFanOut: 5 })
    const distributor = addr(30)
    const recipients = Array.from({ length: 20 }, (_, i) => addr(100 + i))
    for (const r of recipients) cluster.recordFunding(distributor, r)

    // Over the fan-out threshold -> excluded as public infra -> every recipient keeps its own entity.
    expect(cluster.isPublicInfra(distributor)).toBe(true)
    expect(cluster.independentEntityCount(recipients)).toBe(recipients.length)
  })

  it('router wallets (a contract that relays funds to many unrelated wallets) are excluded the same way as an airdrop distributor', () => {
    const cluster = new EntityCluster({ maxFunderFanOut: 5 })
    const router = addr(40)
    const traders = Array.from({ length: 8 }, (_, i) => addr(200 + i))
    for (const t of traders) cluster.recordFunding(router, t)

    expect(cluster.isPublicInfra(router)).toBe(true)
    expect(cluster.independentEntityCount(traders)).toBe(traders.length)
  })

  it('stays UNDER the fan-out threshold: 5 wallets funded by one address DO cluster (boundary case, inclusive)', () => {
    const cluster = new EntityCluster({ maxFunderFanOut: 5 })
    const funder = addr(50)
    const wallets = Array.from({ length: 5 }, (_, i) => addr(300 + i))
    for (const w of wallets) cluster.recordFunding(funder, w)

    expect(cluster.isPublicInfra(funder)).toBe(false)
    expect(cluster.independentEntityCount(wallets)).toBe(1)
  })

  it('crossing the threshold on the 6th funding RETROACTIVELY excludes the funder entirely — real fan-out is only known after enough of it is observed', () => {
    const cluster = new EntityCluster({ maxFunderFanOut: 5 })
    const funder = addr(60)
    const first5 = Array.from({ length: 5 }, (_, i) => addr(400 + i))
    for (const w of first5) cluster.recordFunding(funder, w)
    expect(cluster.independentEntityCount(first5)).toBe(1) // merged while under threshold

    const sixth = addr(500)
    cluster.recordFunding(funder, sixth) // now fan-out = 6, over threshold
    expect(cluster.isPublicInfra(funder)).toBe(true)
    // The funder's entire signal is now excluded, including the earlier edges — the first 5
    // go back to being independent singletons rather than staying falsely merged.
    expect(cluster.independentEntityCount(first5)).toBe(5)
    expect(cluster.entityOf(sixth)).not.toBe(cluster.entityOf(first5[0]!))
  })

  it('a direct wallet-to-wallet transfer clusters the two wallets, same as shared funding', () => {
    const cluster = new EntityCluster()
    const walletA = addr(70)
    const walletB = addr(71)
    cluster.recordDirectTransfer(walletA, walletB)
    expect(cluster.entityOf(walletA)).toBe(cluster.entityOf(walletB))
  })

  it('path compression keeps entityOf consistent across a longer funding chain (funder-of-funder)', () => {
    const cluster = new EntityCluster()
    const root = addr(80)
    const mid = addr(81)
    const leaf = addr(82)
    cluster.recordFunding(root, mid)
    cluster.recordFunding(mid, leaf)
    expect(cluster.entityOf(root)).toBe(cluster.entityOf(leaf))
  })
})
