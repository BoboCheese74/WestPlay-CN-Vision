import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOLUME,
  hears,
  moveVolume,
  parseVolume,
  soundingVolume,
  startVolume,
  toggleMute,
} from './volume'

describe('the volume, which is the player’s', () => {
  it('starts at what was kept, theirs from the first moment', () => {
    const volume = startVolume(0.35)
    expect(volume).toEqual({ level: 0.35, mine: true })
  })

  it('starts at the default when nothing was kept, still to become theirs', () => {
    expect(startVolume(null)).toEqual({ level: DEFAULT_VOLUME, mine: false })
  })

  it('takes a message’s volume before the player has one of their own', () => {
    expect(hears(startVolume(null), 0.5)).toEqual({ level: 0.5, mine: false })
  })

  it('never lets a message move the player’s own volume — the bug this rule is for', () => {
    // Each message echoes the volume the player dragged: taken as the app's, the bar stepped to a new level a
    // little each time. It's theirs: the message is heard and not obeyed.
    let volume = moveVolume(0.42)
    for (const echoed of [0.9, 0.1, 0.55, 0.42, 1]) {
      volume = hears(volume, echoed)
      expect(volume.level).toBe(0.42)
      expect(volume.mine).toBe(true)
    }
  })

  it('keeps a volume kept from last run, whatever a message says', () => {
    const volume = hears(startVolume(0.7), 0.2)
    expect(volume.level).toBe(0.7)
  })

  it('says nothing of a message without a volume', () => {
    expect(hears(startVolume(null), null)).toEqual({ level: DEFAULT_VOLUME, mine: false })
  })

  it('holds silence as the player’s, so it stays silent', () => {
    const muted = toggleMute(moveVolume(0.6))
    expect(muted).toEqual({ level: 0, mine: true })
    expect(hears(muted, 0.8).level).toBe(0)
  })

  it('comes back from silence, and from any other level, as the player’s own', () => {
    expect(toggleMute({ level: 0, mine: true })).toEqual({ level: DEFAULT_VOLUME, mine: true })
    expect(moveVolume(0.15).level).toBe(0.15)
  })

  it('reads a kept volume back, and refuses what isn’t one', () => {
    expect(parseVolume('0.25')).toBe(0.25)
    expect(parseVolume('0')).toBe(0)
    expect(parseVolume('1.4')).toBe(1)
    expect(parseVolume(null)).toBeNull()
    expect(parseVolume('')).toBeNull()
    expect(parseVolume('loud')).toBeNull()
  })

  it('gives the sound the player’s volume, faded by the cab’s own', () => {
    const volume = moveVolume(0.5)
    expect(soundingVolume(volume, 1)).toBe(0.5)
    expect(soundingVolume(volume, 0)).toBe(0)
    expect(soundingVolume(volume, 0.5)).toBe(0.25)
  })
})
