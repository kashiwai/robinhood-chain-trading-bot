import { describe, expect, it } from 'vitest'
import {
  computeBuildFingerprint,
  evaluateFingerprintMatch,
  resolveGitCommitSha,
} from '../../src/gates/build-fingerprint.js'

function fp(overrides: Partial<Parameters<typeof computeBuildFingerprint>[0]> = {}) {
  return computeBuildFingerprint({
    tradingConfig: { maxPositionUsd: 25 },
    strategyParams: { entryWeth: 0.01 },
    chainId: 4663,
    rpcConfig: { rpcUrl: 'https://rpc.example', wsRpcUrl: undefined, network: 'mainnet' },
    databaseSchemaVersion: '1',
    gitCommitSha: 'abc123',
    ...overrides,
  })
}

describe('resolveGitCommitSha', () => {
  it('prefers GIT_COMMIT_SHA when set, never shells out', () => {
    expect(resolveGitCommitSha({ GIT_COMMIT_SHA: 'deadbeef' })).toBe('deadbeef')
  })
})

describe('computeBuildFingerprint', () => {
  it('the same inputs produce the same hashes deterministically', () => {
    const a = fp()
    const b = fp()
    expect(a.configHash).toBe(b.configHash)
    expect(a.strategyVersion).toBe(b.strategyVersion)
    expect(a.rpcProviderConfigurationHash).toBe(b.rpcProviderConfigurationHash)
  })

  it('a different tradingConfig produces a different configHash', () => {
    const a = fp({ tradingConfig: { maxPositionUsd: 25 } })
    const b = fp({ tradingConfig: { maxPositionUsd: 50 } })
    expect(a.configHash).not.toBe(b.configHash)
  })

  it('a different strategyParams produces a different strategyVersion', () => {
    const a = fp({ strategyParams: { entryWeth: 0.01 } })
    const b = fp({ strategyParams: { entryWeth: 0.02 } })
    expect(a.strategyVersion).not.toBe(b.strategyVersion)
  })

  it('a different rpcConfig produces a different rpcProviderConfigurationHash', () => {
    const a = fp({ rpcConfig: { rpcUrl: 'https://a', wsRpcUrl: undefined, network: 'mainnet' } })
    const b = fp({ rpcConfig: { rpcUrl: 'https://b', wsRpcUrl: undefined, network: 'mainnet' } })
    expect(a.rpcProviderConfigurationHash).not.toBe(b.rpcProviderConfigurationHash)
  })
})

describe('evaluateFingerprintMatch — strict by default, an explicit allow-rule only excuses gitCommitSha', () => {
  it('an identical fingerprint matches with zero mismatches', () => {
    const a = fp()
    const b = fp()
    const result = evaluateFingerprintMatch(a, b)
    expect(result).toEqual({ matches: true, mismatchedFields: [] })
  })

  it('a different gitCommitSha alone is rejected by default (no allow-rule supplied)', () => {
    const recorded = fp({ gitCommitSha: 'old-sha' })
    const current = fp({ gitCommitSha: 'new-sha' })
    const result = evaluateFingerprintMatch(recorded, current)
    expect(result.matches).toBe(false)
    expect(result.mismatchedFields).toContain('gitCommitSha')
  })

  it('a different configHash is rejected, independent of gitCommitSha', () => {
    const recorded = fp({ gitCommitSha: 'sha1', tradingConfig: { maxPositionUsd: 25 } })
    const current = fp({ gitCommitSha: 'sha1', tradingConfig: { maxPositionUsd: 999 } })
    const result = evaluateFingerprintMatch(recorded, current)
    expect(result.matches).toBe(false)
    expect(result.mismatchedFields).toContain('configHash')
  })

  it('a different chainId is rejected (e.g. testnet evidence for a mainnet launch attempt)', () => {
    const recorded = fp({ gitCommitSha: 'sha1', chainId: 46630 })
    const current = fp({ gitCommitSha: 'sha1', chainId: 4663 })
    const result = evaluateFingerprintMatch(recorded, current)
    expect(result.matches).toBe(false)
    expect(result.mismatchedFields).toContain('chainId')
  })

  it('an explicitly allowed prior SHA excuses ONLY the gitCommitSha mismatch', () => {
    const recorded = fp({ gitCommitSha: 'docs-only-sha' })
    const current = fp({ gitCommitSha: 'new-sha' })
    const result = evaluateFingerprintMatch(recorded, current, ['docs-only-sha'])
    expect(result.matches).toBe(true)
    expect(result.mismatchedFields).toEqual([])
  })

  it('an allowed prior SHA does NOT excuse a genuine config/strategy change smuggled under the same "docs-only" claim', () => {
    const recorded = fp({ gitCommitSha: 'docs-only-sha', tradingConfig: { maxPositionUsd: 25 } })
    const current = fp({ gitCommitSha: 'new-sha', tradingConfig: { maxPositionUsd: 999 } })
    const result = evaluateFingerprintMatch(recorded, current, ['docs-only-sha'])
    expect(result.matches).toBe(false)
    expect(result.mismatchedFields).toEqual(['configHash'])
  })

  it('reports every mismatched field, not just the first', () => {
    const recorded = fp({ gitCommitSha: 'a', chainId: 46630, databaseSchemaVersion: '1' })
    const current = fp({ gitCommitSha: 'b', chainId: 4663, databaseSchemaVersion: '2' })
    const result = evaluateFingerprintMatch(recorded, current)
    expect(result.mismatchedFields).toEqual(
      expect.arrayContaining(['gitCommitSha', 'chainId', 'databaseSchemaVersion']),
    )
  })
})
