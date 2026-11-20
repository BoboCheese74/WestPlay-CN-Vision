/**
 * The player's volume: theirs, and only theirs.
 *
 * The rule this module exists for (an owner's report, another player): every playback message carried a volume
 * with it — the player's own, read back and echoed — and the app took what it was given, so the volume stepped
 * to a new level with each message. Here the player's choice is the authority: a message's volume is heard once,
 * before they've chosen anything at all, and never after. `hears` is the whole rule, and it's tested.
 */

/** Where the player's choice is kept between WestPlay's runs. */
export const VOLUME_KEY = 'westplay.netease.volume'

/** How loud the music starts, the first time there's nothing to go on. */
export const DEFAULT_VOLUME = 0.8

/** The volume as the app holds it: what the player chose (0 to 1), and whether it was theirs to choose yet. */
export interface Volume {
  /** 0 to 1. */
  level: number
  /** They dragged it, keyed it, or it was kept from last time: from then on no message moves it. */
  mine: boolean
}

/** `share` as a volume: 0 to 1, a number that isn't one read as silence. */
export function clampVolume(share: number): number {
  if (!Number.isFinite(share)) return 0
  return Math.min(1, Math.max(0, share))
}

/** A kept volume as it reads back (`null`: none kept, or not a volume at all). */
export function parseVolume(stored: string | null): number | null {
  if (stored === null || stored.trim() === '') return null
  const volume = Number(stored)
  return Number.isFinite(volume) ? clampVolume(volume) : null
}

/** The volume the app starts a run with: the kept one (theirs then), else the default (still to be theirs). */
export function startVolume(kept: number | null): Volume {
  return kept === null ? { level: DEFAULT_VOLUME, mine: false } : { level: clampVolume(kept), mine: true }
}

/** The player moved the volume: their own from now on. */
export function moveVolume(share: number): Volume {
  return { level: clampVolume(share), mine: true }
}

/**
 * The player's own volume, from the speaker's button: silenced (`0`) or back to where it was (the last level
 * that wasn't silence). Silence is theirs too, so a mute stays muted.
 */
export function toggleMute(volume: Volume): Volume {
  if (volume.level > 0) return { level: 0, mine: true }
  return { level: DEFAULT_VOLUME, mine: true }
}

/**
 * A playback message's volume, as the app takes it: not at all, once the player has a volume of their own. Before
 * that (the very first song, nothing kept), a volume already in play is a better start than the default — and
 * still not theirs, so a later message may say again, never step it.
 */
export function hears(volume: Volume, said: number | null): Volume {
  if (volume.mine || said === null || !Number.isFinite(said)) return volume
  return { level: clampVolume(said), mine: false }
}

/** What the music plays at. */
export function levelOf(volume: Volume): number {
  return volume.level
}

/** The volume the sound itself is given: the player's, scaled by a fade the cab is running (`share`, 0 to 1). */
export function soundingVolume(volume: Volume, fade: number): number {
  return clampVolume(volume.level * clampVolume(fade))
}
