import { afterEach, describe, expect, it, vi } from 'vitest'

import { receiveCab, setSource, throughCab } from './spatial'

/**
 * The cab's sound, checked by its state and its safety rather than by its sound: the graph needs a real
 * `AudioContext`, which a test page doesn't have, so the tests say the module keeps its state, tells whether the
 * sound is through the cab, and never throws without a browser's audio. The numbers themselves are `cab_sound.js`'s,
 * already proven in the truck.
 */
describe('the cab sound (spatial.ts)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // A fresh cab for each test: the module holds its state between tests.
    receiveCab({ speakers: null, head: { x: 0, y: 0, z: 0, heading: 0, pitch: 0 }, outside: false, distance: 0, equalizer: { bass: 0, mid: 0, treble: 0 } })
    setSource(null)
  })

  it('takes a cab without a browser audio context and stays safe', () => {
    // No AudioContext in the test page: the graph can't be built, and the module must not throw.
    expect(() =>
      receiveCab({
        speakers: [
          { band: [80, 2000], level: 0, channel: 'left', at: [-1, 0.7, -0.2], delay: 0 },
        ],
        head: { x: 0, y: 0, z: 0, heading: 0, pitch: 0 },
        outside: false,
        distance: 0,
        equalizer: { bass: 0, mid: 0, treble: 0 },
      }),
    ).not.toThrow()
  })

  it('is not through the cab when there is no audio context', () => {
    expect(throughCab()).toBe(false)
  })

  it('accepts a source element without a cab and without throwing', () => {
    const element = { onplay: null, onpause: null } as unknown as HTMLAudioElement
    expect(() => setSource(element)).not.toThrow()
  })

  it('tells no cab is through before any speakers arrive', () => {
    expect(throughCab()).toBe(false)
  })
})
