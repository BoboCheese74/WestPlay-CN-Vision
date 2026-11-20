import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 收藏: the heart on the song playing. The layer is stood in for here (the app's own half of it): what the heart
 * lights from, and what it does when the layer won't take the song.
 */

const calls: { id: number; liked: boolean }[] = []
const answer = { ok: true, liked: true, reason: undefined as string | undefined }

vi.mock('./layer', () => ({
  setLiked: (id: number, liked: boolean) => {
    calls.push({ id, liked })
    return Promise.resolve({ ...answer })
  },
  likedSongs: () => Promise.resolve({ liked: [], signedIn: false }),
  account: () => Promise.resolve({ signedIn: false, nickname: '', userId: 0, picture: '', vip: false }),
}))

const { isLiked, toggleLiked, useNetease } = await import('./netease')

/** The app with an account (a guest can't like anything, and that's another test). */
function signedIn(liked: number[] | null = []): void {
  useNetease.setState({
    account: { signedIn: true, nickname: 'me', userId: 42, picture: '', vip: false },
    liked,
    liking: [],
  })
}

describe('toggleLiked', () => {
  beforeEach(() => {
    calls.length = 0
    answer.ok = true
    useNetease.setState({ account: null, liked: null, liking: [] })
  })

  it('adds a song that isn’t there, and says so at once', async () => {
    signedIn([])
    await toggleLiked(7)
    expect(calls).toEqual([{ id: 7, liked: true }])
    expect(isLiked(7)).toBe(true)
  })

  it('takes back a song that is', async () => {
    signedIn([7, 8])
    await toggleLiked(7)
    expect(calls).toEqual([{ id: 7, liked: false }])
    expect(isLiked(7)).toBe(false)
    expect(isLiked(8)).toBe(true)
  })

  it('puts the heart back when the layer won’t take it', async () => {
    signedIn([])
    answer.ok = false
    await toggleLiked(9)
    expect(isLiked(9)).toBe(false)
    expect(useNetease.getState().liking).toEqual([])
  })

  it('does nothing signed out: a guest has no 我喜欢的音乐', async () => {
    useNetease.setState({ account: { signedIn: false, nickname: '', userId: 0, picture: '', vip: false } })
    await toggleLiked(11)
    expect(calls).toEqual([])
  })

  it('sends a song once however fast the heart is pressed', async () => {
    signedIn([])
    const first = toggleLiked(12)
    // A second press while the first is on its way is dropped, not sent again.
    await toggleLiked(12)
    await first
    expect(calls).toEqual([{ id: 12, liked: true }])
  })
})
