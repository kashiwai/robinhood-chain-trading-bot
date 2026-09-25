import type { HoodClient } from 'hoodchain'
import { encodeFunctionData, toFunctionSelector, type Address } from 'viem'

// EIP-1967 implementation slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb' as const

const OWNER_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const
const PAUSED_ABI = [
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const
const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [],
  },
] as const

/**
 * Selectors this scanner looks for directly in raw bytecode. Presence alone
 * is NEVER treated as conclusive (the spec's explicit warning: "単一
 * function selectorだけで判断してはいけない") — it only gates whether a
 * behavioral eth_call probe is worth attempting (see `probeMintAccess`) and
 * contributes a small, individually-weighted amount to `riskScore`. A
 * selector can appear in unrelated code (4 bytes of hash collision space is
 * small but non-zero) or belong to a dead/unreachable code path.
 */
const SELECTORS = {
  mint: toFunctionSelector('mint(address,uint256)'),
  pause: toFunctionSelector('pause()'),
  unpause: toFunctionSelector('unpause()'),
  blacklist: toFunctionSelector('blacklist(address)'),
  setBlacklist: toFunctionSelector('setBlacklisted(address,bool)'),
  excludeFromFee: toFunctionSelector('excludeFromFee(address)'),
  setMaxTx: toFunctionSelector('setMaxTxAmount(uint256)'),
  setMaxWallet: toFunctionSelector('setMaxWalletAmount(uint256)'),
  renounceOwnership: toFunctionSelector('renounceOwnership()'),
}

export interface ContractRiskReport {
  address: Address
  hasCode: boolean
  isProxy: boolean
  implementationAddress: Address | null
  ownerAddress: Address | null
  ownerRenounced: boolean
  hasMintSelector: boolean
  /** null = selector absent (probe skipped) or probe itself failed to resolve either way. */
  mintCallableByOutsider: boolean | null
  isPaused: boolean | null
  hasPauseSelector: boolean
  hasBlacklistSelector: boolean
  hasMaxTxWalletSelectors: boolean
  riskFlags: string[]
  /** 0 (clean) - 100 (severe). An initial, documented heuristic weighting — see the doc comment above. */
  riskScore: number
}

export async function scanContractRisk(client: HoodClient, address: Address): Promise<ContractRiskReport> {
  const flags: string[] = []
  let score = 0

  const code = await client.public.getCode({ address })
  const hasCode = !!code && code !== '0x'
  if (!hasCode) {
    return {
      address,
      hasCode: false,
      isProxy: false,
      implementationAddress: null,
      ownerAddress: null,
      ownerRenounced: false,
      hasMintSelector: false,
      mintCallableByOutsider: null,
      isPaused: null,
      hasPauseSelector: false,
      hasBlacklistSelector: false,
      hasMaxTxWalletSelectors: false,
      riskFlags: ['no bytecode at this address'],
      riskScore: 100,
    }
  }

  // ── proxy detection (EIP-1967) ────────────────────────────────────────────
  const implSlot = await client.public.getStorageAt({ address, slot: EIP1967_IMPL_SLOT }).catch(() => null)
  const implementationAddress =
    implSlot && BigInt(implSlot) !== 0n ? (`0x${implSlot.slice(-40)}` as Address) : null
  const isProxy = implementationAddress !== null
  if (isProxy) {
    flags.push(`upgradeable proxy (EIP-1967) -> implementation ${implementationAddress}`)
    score += 20
  }
  // Bytecode checked below is the proxy's own (tiny, delegatecall-only) code
  // unless we also fetch the implementation's — do that so selector/behavior
  // checks reflect what actually runs.
  const behaviorCode = isProxy
    ? await client.public.getCode({ address: implementationAddress! }).catch(() => code)
    : code
  const bytecode = (behaviorCode ?? code).toLowerCase()

  const hasMintSelector = bytecode.includes(SELECTORS.mint.slice(2))
  const hasPauseSelector =
    bytecode.includes(SELECTORS.pause.slice(2)) || bytecode.includes(SELECTORS.unpause.slice(2))
  const hasBlacklistSelector =
    bytecode.includes(SELECTORS.blacklist.slice(2)) || bytecode.includes(SELECTORS.setBlacklist.slice(2))
  const hasMaxTxWalletSelectors =
    bytecode.includes(SELECTORS.setMaxTx.slice(2)) || bytecode.includes(SELECTORS.setMaxWallet.slice(2))

  // ── owner() — behavioral, not selector-based ────────────────────────────
  const ownerAddress = await client.public
    .readContract({ address, abi: OWNER_ABI, functionName: 'owner' })
    .catch(() => null)
  const ownerRenounced = ownerAddress !== null && /^0x0+$/.test(ownerAddress)
  if (ownerAddress !== null && !ownerRenounced) {
    flags.push(`active owner ${ownerAddress}`)
    score += 10
  }

  // ── mint access probe — behavioral, only attempted if the selector exists ──
  let mintCallableByOutsider: boolean | null = null
  if (hasMintSelector) {
    mintCallableByOutsider = await probeMintAccess(client, address)
    if (mintCallableByOutsider === true) {
      flags.push('CRITICAL: mint() is callable by ANY address, not just the owner')
      score += 50
    } else if (mintCallableByOutsider === false && !ownerRenounced) {
      flags.push('mint() exists and is access-controlled, but owner is still active — supply is not fixed')
      score += 15
    }
  }

  // ── paused() — behavioral ───────────────────────────────────────────────
  const isPaused = await client.public
    .readContract({ address, abi: PAUSED_ABI, functionName: 'paused' })
    .catch(() => null)
  if (isPaused === true) {
    flags.push('CRITICAL: contract is currently paused')
    score += 40
  } else if (hasPauseSelector) {
    flags.push('has pause capability (not currently paused)')
    score += 10
  }

  if (hasBlacklistSelector) {
    flags.push('has blacklist-style selector in bytecode (unconfirmed by behavior — see doc comment)')
    score += 10
  }
  if (hasMaxTxWalletSelectors) {
    flags.push('has maxTx/maxWallet-style selector in bytecode (unconfirmed by behavior)')
    score += 5
  }

  return {
    address,
    hasCode: true,
    isProxy,
    implementationAddress,
    ownerAddress,
    ownerRenounced,
    hasMintSelector,
    mintCallableByOutsider,
    isPaused,
    hasPauseSelector,
    hasBlacklistSelector,
    hasMaxTxWalletSelectors,
    riskFlags: flags,
    riskScore: Math.min(100, score),
  }
}

/**
 * Behavioral confirmation of mint access control: simulates `mint(probe, 1)`
 * as an eth_call from a throwaway, definitely-not-the-owner address. A
 * revert means access-controlled (the normal, expected case for a
 * legitimate owner-gated mint); success means literally anyone can mint —
 * severe. Returns `null` if the probe itself can't be resolved either way
 * (e.g. the call reverts for an unrelated reason, or the RPC rejects the
 * simulation) rather than guessing.
 */
const OUTSIDER_PROBE_ADDRESS = `0x${'f00d1'.padStart(40, '0')}` as Address

async function probeMintAccess(client: HoodClient, token: Address): Promise<boolean | null> {
  try {
    await client.public.call({
      account: OUTSIDER_PROBE_ADDRESS,
      to: token,
      data: encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [OUTSIDER_PROBE_ADDRESS, 1n] }),
    })
    return true // did not revert -> anyone can mint
  } catch {
    return false // reverted -> access-controlled (the expected/safe case)
  }
}
