import { describe, expect, it } from 'vitest'
import { isReleasedApp, RELEASED_APP_IDS } from './apps'

describe('the apps this release has', () => {
  it('leaves Phone and Messages for a later release, keeping Home’s order', () => {
    expect(RELEASED_APP_IDS).toEqual([
      'maps',
      'music',
      'spotify',
      'youtube',
      'youtubeMusic',
      'player',
      'safari',
        'radio',
      'calendar',
      'vehicle',
      'weather',
      'douyin',
      'kugou',
      'settings',
    ])
  })

  it('opens none of the later ones from a saved screen or recent', () => {
    expect(isReleasedApp('phone')).toBe(false)
    expect(isReleasedApp('messages')).toBe(false)
    // Podcasts (Qingting FM) is gone: the Live Radio app took its place (owner 2026-11-18).
  expect(isReleasedApp('podcasts')).toBe(false)
    expect(isReleasedApp('calendar')).toBe(true)
    expect(isReleasedApp('nonsense')).toBe(false)
  })
})
