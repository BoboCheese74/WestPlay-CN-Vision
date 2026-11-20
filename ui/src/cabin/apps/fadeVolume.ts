/**
 * A player's volume, ramped rather than cut.
 *
 * A song that stops the instant the player presses pause clicks: the sound goes from full to nothing between
 * one sample and the next. The same in reverse as it starts. A second of ramp on each end is what makes pause
 * and play sound like a player rather than a switch (owner 2026-11-20, for QQ Music, NetEase Cloud Music and
 * Kugou).
 *
 * The ramp is written once here and used by all three, because each of them holds its volume differently:
 * NetEase Cloud Music's app owns an `Audio` element and sets its level directly, while QQ Music and Kugou are
 * pages the host runs, so their level is a number the host is told. A `Ramp` doesn't care which: it is given a
 * way to set a level, and calls it.
 *
 * What it must not do is lose the player's own volume. A fade is a *factor* over that choice, never a change to
 * it: when the ramp reaches zero the player's level is still what they set, so coming back restores it exactly.
 * (The reported bug where a level jumped to a fresh one on every playback message was the same mistake, one
 * layer up.)
 */

/** How long a pause's ramp down, or a play's ramp up, takes, ms. */
export const FADE_MS = 1000

/** About sixty steps a second: smooth to the eye and the ear, and few enough for a page drawing at 30. */
const STEP_MS = 16

/**
 * Something whose level can be set: the element of an app that plays here, or the host's own page.
 *
 * `set` is given the level to play at *now*, 0 to 1, already multiplied by the player's choice — the ramp never
 * sees or alters that choice, so nothing here can lose it.
 */
export interface LevelSink {
  set(level: number): void
}

/**
 * One player's ramp.
 *
 * `rampTo` cancels whatever was running, so a pause interrupted by a play (or the reverse) turns round from
 * where the level had got to rather than from where the last ramp began.
 */
export class Ramp {
  private readonly sink: LevelSink
  /** The factor the sound is at now, 0 to 1 — the ramp's own, which the player's choice multiplies. */
  private factor: number
  /** The player's own choice, 0 to 1. */
  private share: number
  /** The step timer of the ramp running, if any. */
  private timer: ReturnType<typeof setInterval> | null = null
  /** The timer that lands the ramp on its target, if a ramp is running. */
  private end: ReturnType<typeof setTimeout> | null = null
  /** The last level `set` was given, so a ramp that would repeat it doesn't. */
  private last = -1

  /**
   * @param sink where a level goes
   * @param share the player's own choice, 0 to 1: the ramp multiplies this and never changes it
   * @param start the factor to begin at: 1 for a player that starts audible, 0 for one that fades in first
   */
  constructor(sink: LevelSink, share = 1, start = 1) {
    this.sink = sink
    this.share = Math.min(1, Math.max(0, share))
    this.factor = Math.min(1, Math.max(0, start))
    this.apply(this.factor)
  }

  /** The player's choice, 0 to 1, which the ramp multiplies. */
  setShare(share: number): void {
    this.share = Math.min(1, Math.max(0, share))
    // A ramp in flight keeps its factor: the new choice is heard at once, scaled by how far the ramp has come.
    this.apply(this.factor)
  }

  /** The level the player hears now, 0 to 1 (the choice times the ramp's factor). */
  get current(): number {
    return this.factor * this.share
  }

  /** Whether a ramp is running. */
  get running(): boolean {
    return this.timer !== null || this.end !== null
  }

  /**
   * Ramps to `factor` (1 audible, 0 silent) over `ms`.
   *
   * The last step lands on the target exactly. A timer can't be trusted to fire on the millisecond it was asked
   * for — and a fade that stopped at 0.00003, or at 0.49997, is a fade that didn't finish: the first is a click
   * the whole ramp existed to avoid, the second is a song left a hair quieter than the player set it.
   */
  rampTo(factor: number, ms = FADE_MS): void {
    this.cancel()
    const target = Math.min(1, Math.max(0, factor))
    const from = this.factor
    if (ms <= 0 || from === target) {
      this.factor = target
      this.apply(target)
      return
    }
    const started = clock()
    const step = () => {
      const gone = (clock() - started) / ms
      if (gone >= 1) {
        this.finish(target)
        return
      }
      // Eased: a straight line is audible as a line; this leaves and arrives softly, as a hand on a dial does.
      this.factor = target + (from - target) * (1 - gone) ** 2
      this.apply(this.factor)
    }
    this.timer = setInterval(step, STEP_MS)
    // The end, on a timer of the ramp's own length. A `setInterval` fires on its own interval, not on the
    // millisecond asked for — 1000ms at 16ms a step has no step at 1000 — so without this the fade would stop a
    // step short of its target.
    this.end = setTimeout(() => this.finish(target), ms)
  }

  /** Stops a ramp where it is, keeping the factor it reached. */
  cancel(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.end !== null) {
      clearTimeout(this.end)
      this.end = null
    }
  }

  /** Silences at once, ramps and all: for a player taken away (the cab's electrics off). */
  silence(): void {
    this.cancel()
    this.factor = 0
    this.apply(0)
  }

  /** The end of a ramp: the target exactly, and no timer left. */
  private finish(target: number): void {
    this.cancel()
    this.factor = target
    // The sink is told the target even if it was given a level a hair off it: rounding mustn't leave a song at
    // 0.99997 of what the player set.
    this.last = -1
    this.apply(target)
  }

  private apply(factor: number): void {
    const level = Math.min(1, Math.max(0, factor * this.share))
    if (level === this.last) return
    this.last = level
    this.sink.set(level)
  }
}

/** The clock a ramp runs on: the page's own, which `vi.useFakeTimers` also moves. */
function clock(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
