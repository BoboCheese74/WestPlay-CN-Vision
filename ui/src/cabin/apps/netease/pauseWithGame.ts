import { type MusicPlayer, pauseMusicWithGame } from '../musicWithGame'
import { playingNow, pauseNow, resumeNow, setFade, setVolume, skip, useNetease, volumeNow } from './netease'

/**
 * NetEase Cloud Music as one of the cab's players (musicWithGame.ts, oneAtATime.ts, keybinds).
 *
 * The fade is the app's own: the sound is an `Audio` element of this page, so its level is set here rather than
 * asked of a site's page (which keeps its own). The player's volume stays as they set it: a fade only scales what
 * the sound gets, never the volume the app shows or keeps (volume.ts).
 */
export const neteasePlayer: MusicPlayer = {
  name: 'netease',
  playingHere: playingNow,
  pauseHere: pauseNow,
  resumeHere: resumeNow,
  volume: volumeNow,
  // The fade's own level, as a share of the player's volume (its slider is left where they put it).
  sendVolume: (share) => {
    const chosen = volumeNow()
    setFade(chosen > 0 ? Math.min(1, share / chosen) : 1)
  },
  // A keybind's volume is the player's own choice.
  setVolume: (share) => setVolume(share),
  skip,
  // Started: from not playing to playing.
  subscribe: (changed) =>
    useNetease.subscribe((now, before) => {
      if (now.playback?.playing && !before.playback?.playing) changed(true)
      else if (!now.playback?.playing && before.playback?.playing) changed(false)
    }),
}

/** NetEase Cloud Music with the game (musicWithGame.ts). Returns the function that stops it. */
export function pauseNeteaseWithGame(): () => void {
  return pauseMusicWithGame(neteasePlayer)
}
