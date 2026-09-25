import { describe, expect, it } from 'vitest'
import {
  evaluateExit,
  INITIAL_EXIT_STATE,
  DEFAULT_EXIT_CONFIG,
  type ExitState,
} from '../../src/exits/exit-engine.js'

describe("evaluateExit — the spec's exact tier ladder", () => {
  it('stop-loss fires a full exit at -12%, from a fresh position', () => {
    const { decision } = evaluateExit(-0.12, INITIAL_EXIT_STATE)
    expect(decision?.tier).toBe('stop_loss')
    expect(decision?.sellFractionOfCurrent).toBe(1)
  })

  it('stop-loss fires even deeper than -12%', () => {
    const { decision } = evaluateExit(-0.5, INITIAL_EXIT_STATE)
    expect(decision?.tier).toBe('stop_loss')
  })

  it('no exit between -12% and +20%', () => {
    const { decision } = evaluateExit(0.05, INITIAL_EXIT_STATE)
    expect(decision).toBeNull()
  })

  it('TP1 fires at +20%, selling 25% of current (== original, since nothing sold yet)', () => {
    const { decision, newState } = evaluateExit(0.2, INITIAL_EXIT_STATE)
    expect(decision?.tier).toBe('tp1')
    expect(decision?.sellFractionOfCurrent).toBeCloseTo(0.25, 6)
    expect(newState.tp1Taken).toBe(true)
  })

  it('TP1 does not re-fire once already taken', () => {
    const afterTp1: ExitState = { ...INITIAL_EXIT_STATE, tp1Taken: true }
    const { decision } = evaluateExit(0.25, afterTp1)
    expect(decision).toBeNull() // not yet at TP2's 40%
  })

  it('TP2 fires at +40% (after TP1), selling 25% of ORIGINAL — which is 1/3 of what remains after TP1', () => {
    const afterTp1: ExitState = { ...INITIAL_EXIT_STATE, tp1Taken: true }
    const { decision, newState } = evaluateExit(0.4, afterTp1)
    expect(decision?.tier).toBe('tp2')
    // remaining after TP1 = 75% of original; selling 25% of ORIGINAL = 25/75 = 33.3% of current
    expect(decision?.sellFractionOfCurrent).toBeCloseTo(1 / 3, 4)
    expect(newState.tp2Taken).toBe(true)
    expect(newState.peakPnlPctSinceTp2).toBeCloseTo(0.4, 6)
  })

  it('TP2 cannot fire before TP1 — a pnl that already exceeds BOTH thresholds fires TP1 first (TP2 follows on a later tick)', () => {
    const { decision, newState } = evaluateExit(0.45, INITIAL_EXIT_STATE)
    expect(decision?.tier).toBe('tp1') // not tp2, even though 45% already clears TP2's 40% bar too
    expect(newState.tp2Taken).toBe(false)
  })

  it('after TP2, the position holds (no exit) while pnl keeps climbing — the trailing peak just updates', () => {
    const afterTp2: ExitState = { tp1Taken: true, tp2Taken: true, peakPnlPctSinceTp2: 0.4 }
    const { decision, newState } = evaluateExit(0.6, afterTp2)
    expect(decision).toBeNull()
    expect(newState.peakPnlPctSinceTp2).toBeCloseTo(0.6, 6)
  })

  it('trailing stop fires once pnl drops 15 points below the post-TP2 peak', () => {
    const afterTp2: ExitState = { tp1Taken: true, tp2Taken: true, peakPnlPctSinceTp2: 0.6 }
    const { decision } = evaluateExit(0.44, afterTp2) // 60% - 16pt = 44%, past the 15pt trail
    expect(decision?.tier).toBe('trailing_stop')
    expect(decision?.sellFractionOfCurrent).toBe(1) // the entire remainder
  })

  it('trailing stop does NOT fire within the 15-point band of the peak', () => {
    const afterTp2: ExitState = { tp1Taken: true, tp2Taken: true, peakPnlPctSinceTp2: 0.6 }
    const { decision } = evaluateExit(0.5, afterTp2) // only 10pt off peak
    expect(decision).toBeNull()
  })

  it('stop-loss still overrides everything even after TP1/TP2 have fired — a crash after partial profit-taking is still a stop-loss, not a trailing-stop path', () => {
    const afterTp2: ExitState = { tp1Taken: true, tp2Taken: true, peakPnlPctSinceTp2: 0.6 }
    const { decision } = evaluateExit(-0.2, afterTp2)
    expect(decision?.tier).toBe('stop_loss')
  })

  it('custom config thresholds are respected', () => {
    const tightSL = { ...DEFAULT_EXIT_CONFIG, stopLossPct: 0.05 }
    const { decision } = evaluateExit(-0.06, INITIAL_EXIT_STATE, tightSL)
    expect(decision?.tier).toBe('stop_loss')
  })

  it('a full round trip through all four tiers in sequence produces the expected state machine', () => {
    let state = INITIAL_EXIT_STATE
    let r = evaluateExit(0.2, state)
    expect(r.decision?.tier).toBe('tp1')
    state = r.newState

    r = evaluateExit(0.4, state)
    expect(r.decision?.tier).toBe('tp2')
    state = r.newState

    r = evaluateExit(0.5, state) // climbs further, no exit, peak updates
    expect(r.decision).toBeNull()
    state = r.newState

    r = evaluateExit(0.3, state) // 50% - 30% = 20pt drop, past the 15pt trail
    expect(r.decision?.tier).toBe('trailing_stop')
  })
})
