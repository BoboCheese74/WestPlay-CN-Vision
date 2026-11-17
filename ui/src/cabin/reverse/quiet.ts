import { fade, levelOf, stopFade } from '../apps/fade'
import type { MusicPlayer } from '../apps/musicWithGame'
import { useLive } from '../state/store'
import { reversing } from './reverse'

/**
 * The music falls quiet while the truck reverses (owner, 2026-11-01, FIXES §45): the camera takes the whole screen,
 * and the sounds outside the truck — the trailer, the brakes, a voice behind — are what the driver needs then.
 * What a player is held at, and how long the fall and the return take, are this module's own (`fade.ts` does the
 * stepping, so a player's own slider and volume keybinds are left as the player set them).
 */

/** The volume the music is held at while reversing, as a share: 15 of 100, not 15 less (§45.4). */
export const REVERSING_VOLUME = 0.15

/** How long the fall and the return take, ms (the game fades in with it, §45.2). */
const QUIET_MS = 300

/** Two volumes this close are the same one: a player reporting back what a fade sent it. */
const SAME = 0.005

/**
 * Holds the cab's players at `REVERSING_VOLUME` while the truck reverses, and puts them back on the way out: each
 * player's own volume before it, unless the player set a new one while reversing (then that one). Players already
 * at or under the volume, and those with none to set (Spotify on another device, a page not loaded), are left
 * alone. Returns the function that stops it, which also stops any fade still running.
 */
export function quietWhileReversing(players: readonly MusicPlayer[]): () => void {
  /** What each player was at before it was quietened, by name. */
  const before = new Map<string, number>()
  const fallQuiet = () => {
    for (const player of players) {
      const volume = player.volume()
      // Already at or under the level: left exactly where the player set it. Told to duck anyway, a page
      // that keeps its own volume (Bilibili's, Douyin's) was held *at* the level instead — 5% or 10%
      // turned up to 15% as the truck reversed, and back down on the way out (owner 2026-11-18).
      if (volume !== null && volume <= REVERSING_VOLUME + SAME) continue
      // A page that keeps its own volume is held quiet by the page itself (owner 2026-11-03: Bilibili's
      // fell not at all otherwise): its own volume back when the reversing stops.
      player.duck?.(REVERSING_VOLUME)
      if (volume === null) continue
      before.set(player.name, volume)
      fade(player.name, player.sendVolume, levelOf(player.name) ?? volume, REVERSING_VOLUME, QUIET_MS)
    }
  }
  const comeBack = () => {
    for (const player of players) {
      const was = before.get(player.name)
      if (was === undefined) continue
      before.delete(player.name)
      // Let go of the cab's own quiet: the page's own volume back as it was. Only the players this module
      // held are told, so one it left alone never gets a volume it didn't lose.
      player.duck?.(null)
      const volume = player.volume()
      // Still at what the fade left it: the player's own volume is the one to return to. A player that set a new
      // one while reversing has said what it wants.
      const to = volume !== null && Math.abs(volume - REVERSING_VOLUME) <= SAME ? was : (volume ?? was)
      fade(player.name, player.sendVolume, levelOf(player.name) ?? volume ?? was, to, QUIET_MS)
    }
  }
  let quiet = reversing(useLive.getState())
  if (quiet) fallQuiet()
  const stop = useLive.subscribe((live) => {
    const now = reversing(live)
    // Telemetry says something every tick: only the gear changing is this module's business.
    if (now === quiet) return
    quiet = now
    if (now) fallQuiet()
    else comeBack()
  })
  return () => {
    stop()
    for (const name of before.keys()) stopFade(name)
    before.clear()
  }
}
