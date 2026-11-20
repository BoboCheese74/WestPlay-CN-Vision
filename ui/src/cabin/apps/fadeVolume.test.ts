import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FADE_MS, Ramp } from './fadeVolume'

/**
 * The ramp, checked by its levels rather than by its timer: `vi.useFakeTimers` moves the clock the ramp reads, so
 * each assertion is about where the sound was at a moment, which is what a player hears.
 */
describe('Ramp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A sink that keeps the last level it was given, and every one before it. */
  function sink() {
    const levels: number[] = []
    return {
      levels,
      last: () => levels[levels.length - 1],
      set: (level: number) => levels.push(level),
    }
  }

  it('starts at the player\'s own level', () => {
    const out = sink()
    new Ramp(out, 0.8)
    expect(out.last()).toBeCloseTo(0.8, 5)
  })

  it('reaches silence in a second when ramped down', () => {
    const out = sink()
    const ramp = new Ramp(out, 0.5)
    ramp.rampTo(0)
    vi.advanceTimersByTime(FADE_MS)
    expect(out.last()).toBe(0)
    expect(ramp.running).toBe(false)
  })

  it('comes back to exactly the player\'s level, not near it', () => {
    const out = sink()
    const ramp = new Ramp(out, 0.5)
    ramp.rampTo(0)
    vi.advanceTimersByTime(FADE_MS)
    ramp.rampTo(1)
    vi.advanceTimersByTime(FADE_MS)
    // The whole point of the factor: the choice survives the fade, so 0.5 comes back as 0.5 and not 0.49…
    expect(out.last()).toBe(0.5)
  })

  it('is half way down at half the time, within the ease', () => {
    const out = sink()
    const ramp = new Ramp(out, 1)
    ramp.rampTo(0)
    vi.advanceTimersByTime(FADE_MS / 2)
    // Eased, so by the half-way moment it's already below a straight line's half: quiet, not loud, then quiet.
    expect(out.last()).toBeLessThan(0.5)
    expect(out.last()).toBeGreaterThan(0)
  })

  it('turns round from where it had got to, not from where it started', () => {
    const out = sink()
    const ramp = new Ramp(out, 1)
    ramp.rampTo(0)
    vi.advanceTimersByTime(FADE_MS / 2)
    const midway = out.last()!
    ramp.rampTo(1)
    // A step later it's louder than the midway point, but nowhere near full: it turned round in place.
    vi.advanceTimersByTime(16)
    expect(out.last()).toBeGreaterThan(midway)
    expect(out.last()).toBeLessThan(1)
  })

  it('keeps the player\'s new level at once when they move the slider mid-fade', () => {
    const out = sink()
    const ramp = new Ramp(out, 1)
    ramp.rampTo(0)
    vi.advanceTimersByTime(FADE_MS / 4)
    const factor = ramp.current
    ramp.setShare(0.4)
    // The ramp's factor is unchanged; the choice under it is: what's heard is 0.4 times where the fade had got.
    expect(out.last()).toBeCloseTo(0.4 * factor, 5)
  })

  it('silences at once for a player taken away', () => {
    const out = sink()
    const ramp = new Ramp(out, 1)
    ramp.rampTo(0)
    vi.advanceTimersByTime(FADE_MS / 4)
    ramp.silence()
    expect(out.last()).toBe(0)
    expect(ramp.running).toBe(false)
  })

  it('does not repeat a level it has already given the sink', () => {
    const out = sink()
    const ramp = new Ramp(out, 1)
    ramp.rampTo(0, 10)
    vi.advanceTimersByTime(10)
    const count = out.levels.length
    // Already there: a ramp to the level it holds changes nothing, so the sink isn't called at all.
    ramp.rampTo(0, 10)
    expect(out.levels.length).toBe(count)
  })
})
