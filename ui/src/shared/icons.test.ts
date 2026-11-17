import { describe, expect, it } from 'vitest'
import { type AppIconRole, appIcon } from './icons'

// The icon files there are (public/icons/westplay), as Vite sees them.
const FILES = Object.keys(import.meta.glob('../../public/icons/westplay/*.{svg,png}')).map((path) =>
  path.replace('../../public', ''),
)

const ROLES: AppIconRole[] = [
  'maps',
  'music',
  'spotify',
  'podcasts',
  'radio',
  'messages',
  'phone',
  'calendar',
  'settings',
  'weather',
  'youtube',
  'youtubeMusic',
  'player',
  'safari',
  'vehicle',
  'douyin',
  'kugou',
]

describe('appIcon', () => {
  it('gives every role WestPlay\'s icon in the look asked for, and each file is there', () => {
    for (const role of ROLES) {
      for (const look of ['light', 'dark'] as const) {
        expect(FILES).toContain(appIcon(role, look))
      }
    }
    // Every role is WestPlay's own drawing, light and dark: the player's icon set is SVG in both
    // looks (icons.ts, `PICTURES` empty — owner 2026-11-16: the set replaced the PNGs the music
    // services' and Bilibili's marks used to be).
    for (const role of ROLES) {
      expect(appIcon(role, 'light')).toMatch(/\.light\.svg$/)
      expect(appIcon(role, 'dark')).toMatch(/\.dark\.svg$/)
    }
  })
})
