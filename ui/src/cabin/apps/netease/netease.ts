import { useEffect, useState } from 'react'
import { create } from 'zustand'
import * as audio from './audio'
import {
  type Account,
  type Artist,
  account as askAccount,
  type Collection,
  likedSongs,
  setLiked,
  type SignInStart,
  type SignInState,
  type Song,
  lyric,
  signInPoll,
  signInStart,
  signOut as signOutAtLayer,
  url as audioUrl,
} from './layer'
import { parseLrc, type Words } from './lyrics'
import { hears, levelOf, moveVolume, parseVolume, soundingVolume, startVolume, VOLUME_KEY, type Volume } from './volume'

/**
 * The NetEase Cloud Music app's state: the tabs and their pages, what plays, the account and the words.
 *
 * Unlike the other music apps, nothing here goes through the host to reach the service. The host runs the layer
 * (crates/host netease_layer.rs), the page asks the layer over the loopback, and the sound is a plain `Audio`
 * element fed a song's address. So the app is the player itself: there's no second place that knows what plays,
 * and nothing to follow but its own element.
 *
 * The volume is the player's alone (volume.ts): no message can move it, which is the one rule that has bitten the
 * cab's other players.
 */

export type { Account, Artist, Collection, Song, SignInState }
export type { Words, LyricLine } from './lyrics'

export type Tab = 'recommend' | 'playlists' | 'channels' | 'mine'
export const TABS: readonly Tab[] = ['recommend', 'playlists', 'channels', 'mine']

export type Repeat = 'off' | 'all' | 'one'

/** A page over the tab's own. */
export type View =
  /** A playlist's page (a chart's is one of these: a chart is a playlist the service keeps). */
  | { n: number; kind: 'playlist'; id: number; name: string; picture: string; creator: string; count: number }
  | { n: number; kind: 'album'; id: number; name: string; picture: string; artist: string }
  | { n: number; kind: 'artist'; id: number; name: string; picture: string }
  | { n: number; kind: 'results'; query: string }

/** A page as it's opened: its place in the tab's stack is the stack's to give. */
type Unidentified<T> = T extends unknown ? Omit<T, 'n'> : never

/** Where what plays plays from. */
export interface PlayContext {
  kind: 'playlist' | 'album' | 'artist' | 'search'
  /** The collection's id (`0` for a search's own list). */
  id: number
  name: string
}

/**
 * A song's sound as the app knows it. `unplayable` is the service's own answer (no address, or its code -110:
 * no right to the song here): the app says so and moves on to the next song, rather than sitting on silence.
 */
export type SoundState = 'loading' | 'ready' | 'unplayable'

/** What plays: the songs and which of them, how far, and how. */
export interface Playback {
  context: PlayContext | null
  tracks: Song[]
  index: number
  playing: boolean
  /** Seconds into the song at `at` (`performance.now()`). */
  position: number
  at: number
  /** Seconds: the song's own length (the sound's, where the two disagree). */
  duration: number
  shuffle: boolean
  repeat: Repeat
  /** The way the last change of song went (the cover slides that way). */
  direction: 1 | -1
  sound: SoundState
}

/** The QR sign-in as it stands: asking the layer, showing the code and waiting, or where it got to. */
export interface SignIn {
  state: SignInState | 'asking' | 'failed'
  /** The address the code holds. */
  url: string
  key: string
}

interface NeteaseState {
  tab: Tab
  /** Each tab's pages over its own, the one showing last (each tab is kept where it was left). */
  views: Record<Tab, View[]>
  /** Now Playing is open, over the app. */
  nowPlaying: boolean
  /** Now Playing shows the words in the cover's place. */
  lyrics: boolean
  /** Now Playing shows what comes next in the cover's place. */
  queue: boolean

  playback: Playback | null
  /** The player's own volume, and whether it's theirs yet (volume.ts). */
  volume: Volume
  /** The level a fade holds the sound at (1: none), as the cab's players' `sendVolume` sets it. */
  fade: number

  /** The account, once the layer has said (`null` until then). */
  account: Account | null
  signIn: SignIn | null
  /** Every song 我喜欢的音乐 holds, as last read (`null`: not asked yet). */
  liked: number[] | null
  /** The songs whose heart is on its way to the layer (a second press waits rather than doubles). */
  liking: number[]
  /** The song the service had no right to, as the app said so (a new one is a new moment). */
  unsung: { id: number; name: string; n: number } | null
}

/** The words asked for so far, by song (`null`: the service has none for it). Kept for this session. */
const words = new Map<number, Words | null>()
/** The words being asked for, by song, so two views of one song ask once. */
const askingWords = new Map<number, Promise<Words | null>>()
/** The answers pages have had, by their question (`useLoad`). */
const answers = new Map<string, unknown>()

// --- What's kept between runs ------------------------------------------------------------------------------

const TAB_KEY = 'westplay.netease.tab'

/** The tab the app was left at (推荐 otherwise). */
export function keptTab(): Tab {
  try {
    const kept = localStorage.getItem(TAB_KEY)
    return kept === 'playlists' || kept === 'channels' || kept === 'mine' ? kept : 'recommend'
  } catch {
    return 'recommend'
  }
}

function keepTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Storage blocked: the app opens on 推荐, as ever.
  }
}

/** The player's volume kept from last run (volume.ts has the rule). */
export function keptVolume(): number | null {
  try {
    return parseVolume(localStorage.getItem(VOLUME_KEY))
  } catch {
    return null
  }
}

function keepVolume(volume: Volume): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(levelOf(volume)))
  } catch {
    // Storage blocked: the volume holds for this run only.
  }
}

export const useNetease = create<NeteaseState>()(() => ({
  tab: keptTab(),
  views: { recommend: [], playlists: [], channels: [], mine: [] },
  nowPlaying: false,
  lyrics: false,
  queue: false,
  playback: null,
  volume: startVolume(keptVolume()),
  fade: 1,
  account: null,
  signIn: null,
  liked: null,
  liking: [],
  unsung: null,
}))

// --- Going around ------------------------------------------------------------------------------------------

let nextView = 1

/** A tab, pressed: the app is on it from now on (and opens on it next run). */
export function openTab(tab: Tab): void {
  useNetease.setState({ tab })
  keepTab(tab)
}

/** A page over the tab's own. */
export function openView(view: Unidentified<View>): void {
  const { tab, views } = useNetease.getState()
  useNetease.setState({ views: { ...views, [tab]: [...views[tab], { ...view, n: nextView++ } as View] } })
}

export function goBack(): void {
  const { tab, views } = useNetease.getState()
  useNetease.setState({ views: { ...views, [tab]: views[tab].slice(0, -1) } })
}

/** A playlist or a chart pressed: its page. */
export function openCollection(collection: {
  id: number
  name: string
  picture: string
  creator?: string
  trackCount?: number
}): void {
  openView({
    kind: 'playlist',
    id: collection.id,
    name: collection.name,
    picture: collection.picture,
    creator: collection.creator ?? '',
    count: collection.trackCount ?? 0,
  })
}

export function openAlbum(album: { id: number; name: string; picture: string; artist?: string }): void {
  openView({ kind: 'album', id: album.id, name: album.name, picture: album.picture, artist: album.artist ?? '' })
}

export function openArtist(artist: { id: number; name: string; picture: string }): void {
  openView({ kind: 'artist', id: artist.id, name: artist.name, picture: artist.picture })
}

/** A song's album page (its name and cover are its own song's, until the page's answer comes). */
export function openSongAlbum(song: Song): void {
  if (!song.albumId) return
  openAlbum({ id: song.albumId, name: song.album, picture: song.picture })
}

/** A song's first artist's page. */
export function openSongArtist(song: Song): void {
  const id = song.artistIds[0]
  if (!id) return
  openArtist({ id, name: song.artists[0] ?? '', picture: '' })
}

// --- Playing -----------------------------------------------------------------------------------------------

/** Seconds into the song now (`now`: the clock's last tick, which may be older than the song's own time). */
export function positionOf(playback: Playback, now = performance.now()): number {
  const running = playback.playing && playback.sound === 'ready'
  const position = running ? playback.position + Math.max(0, now - playback.at) / 1000 : playback.position
  return Math.min(position, playback.duration)
}

export function currentTrack(playback: Playback | null): Song | null {
  return playback ? (playback.tracks[playback.index] ?? null) : null
}

/** A change of what plays, shown at once. */
function show(change: Partial<Playback>): void {
  const playback = useNetease.getState().playback
  if (playback) useNetease.setState({ playback: { ...playback, ...change } })
}

/** The song whose address the app is waiting for (another pressed meanwhile: the answer is dropped). */
let waitingFor: number | null = null

/** Plays a list's songs from `index` (`null`: from the start, or anywhere on shuffle). */
export function playFrom(context: PlayContext | null, tracks: Song[], index: number | null): void {
  if (tracks.length === 0) return
  const shuffle = useNetease.getState().playback?.shuffle ?? false
  begin(context, tracks, index ?? (shuffle ? Math.floor(Math.random() * tracks.length) : 0), 1)
}

/** A song on its own (a search's, a card's): it plays, and the list's others after it. */
export function playSong(song: Song, others: Song[] = [song], context: PlayContext | null = null): void {
  const at = others.findIndex((each) => each.id === song.id)
  playFrom(context, at >= 0 ? others : [song], Math.max(0, at))
}

/** Plays a page's songs from somewhere in them (Shuffle), with shuffle on from now on. */
export function shufflePlay(context: PlayContext, tracks: Song[]): void {
  if (tracks.length === 0) return
  const playback = useNetease.getState().playback
  if (playback && !playback.shuffle) show({ shuffle: true })
  begin(context, tracks, Math.floor(Math.random() * tracks.length), 1)
}

/** A song's page, its album's, playing from it (NetEase's own way: a song plays in its album's order). */
function begin(context: PlayContext | null, tracks: Song[], index: number, direction: 1 | -1): void {
  const song = tracks[index]
  if (!song) return
  const was = useNetease.getState().playback
  useNetease.setState({
    playback: {
      context,
      tracks,
      index,
      playing: true,
      position: 0,
      at: performance.now(),
      duration: Math.max(1, song.duration / 1000),
      shuffle: was?.shuffle ?? false,
      repeat: was?.repeat ?? 'off',
      direction,
      sound: 'loading',
    },
  })
  // A fade left running by a pause must not follow the new song (see `endFade`).
  endFade()
  void startSound(song)
}

/**
 * Asks the layer where `song` is, and gives it to the element. The song shows as playing at once (NetEase's own
 * way), but its time is held until the element says it really plays: a browser that refuses the sound (its
 * autoplay rule, a stream that won't load) must not leave a bar running over silence.
 */
async function startSound(song: Song): Promise<void> {
  waitingFor = song.id
  let source
  try {
    source = await audioUrl(song.id)
  } catch {
    if (waitingFor === song.id) unsing(song)
    return
  }
  // Another song pressed while this one's address was on its way.
  if (waitingFor !== song.id) return
  if (!source.url || source.code === -110) {
    unsing(song)
    return
  }
  audio.load(source.url, 0)
  // It starts now. Handing `audio.ts` the address isn't playing: its `canplay` only plays the song when the
  // app already said it wants sound (`wantPlaying`, set by `play`), so a song begun here never started —
  // the bar stayed at 0:00 and the player had to press pause then play to hear anything at all (owner
  // 2026-11-20). `play()` is safe before the element has loaded: it asks again when `canplay` says so.
  audio.play()
  // The fade is the cab's own quiet (the game paused, the truck reversing). It's read here rather than kept
  // a fade left at nothing by a pause that ended (or by a song change while it ran) made the next song start
  // silent — the owner's "换车/切歌后没声音". Sounding at the player's volume, scaled by whatever the cab holds
  // now, is the rule; a song that starts while the game is away is paused by `musicWithGame` a moment later
  // anyway, so no sound leaks out.
  audio.setLevel(soundingVolume(useNetease.getState().volume, useNetease.getState().fade))
}

/** Songs in a row passed over for want of a right to them: past this, a list of them stops rather than running
 * through itself in silence. */
const UNSUNG_MOST = 6
let unsungRun = 0
let unsungTimer: ReturnType<typeof setTimeout> | undefined

/** A song the service won't give here: said, and the next one started. */
function unsing(song: Song): void {
  unsungRun++
  show({ sound: 'unplayable', playing: false })
  useNetease.setState({ unsung: { id: song.id, name: song.name, n: Date.now() } })
  // Said for a few seconds (the app has already gone on to the next song).
  clearTimeout(unsungTimer)
  unsungTimer = setTimeout(() => useNetease.setState({ unsung: null }), 3600)
  if (unsungRun > UNSUNG_MOST) {
    unsungRun = 0
    return
  }
  setTimeout(() => skip(1), 500)
}

/** Plays or pauses what's playing; or, pressed on a page that isn't what plays, plays that page from its start. */
export function playOrPause(context?: PlayContext, tracks?: Song[]): void {
  const playback = useNetease.getState().playback
  if (context && tracks && tracks.length > 0 && playback?.context?.id !== context.id) {
    playFrom(context, tracks, null)
    return
  }
  if (!playback) return
  const now = performance.now()
  if (playback.playing) {
    // A second down, then the element stops: cutting it here is the click this exists to avoid.
    // The app shows it paused at once — what the player pressed — and the sound catches up.
    show({ playing: false, position: positionOf(playback, now), at: now })
    rampFade(0, () => audio.pause())
    return
  }
  audio.play()
  // Up from silence: the element starts, and the ramp brings it in rather than dropping it on the
  // player. A new song (`playFrom`) starts at their level outright: only pause and play ramp.
  rampFade(1)
  // Its time runs from where it stopped once the element says it plays again (`sound` stays as it was: a song
  // whose sound never came has nothing to play on).
  show({ playing: true, at: now })
}

/** The next song (1), or the one before (-1); Back past a song's first seconds is the song's start. */
export function skip(direction: 1 | -1): void {
  const playback = useNetease.getState().playback
  if (!playback) return
  const now = performance.now()
  if (direction === -1 && positionOf(playback, now) > 3) {
    audio.seek(0)
    show({ position: 0, at: now })
    return
  }
  const count = playback.tracks.length
  let index = playback.index + direction
  if (playback.shuffle && direction === 1 && count > 1) {
    index = (playback.index + 1 + Math.floor(Math.random() * (count - 1))) % count
  }
  if (index >= count) {
    if (playback.repeat === 'off') {
      audio.pause()
      audio.seek(0)
      show({ index: 0, position: 0, playing: false, at: now })
      return
    }
    index = 0
  }
  begin(playback.context, playback.tracks, Math.max(0, index), direction)
}

/** A song of the queue pressed (`offset` songs on): it plays from there. */
export function jumpTo(offset: number): void {
  const playback = useNetease.getState().playback
  if (!playback) return
  const index = playback.index + offset
  if (!playback.tracks[index]) return
  begin(playback.context, playback.tracks, index, offset < 0 ? -1 : 1)
}

/** Seconds into the song, as the bar was let go at. */
export function seek(seconds: number): void {
  if (!useNetease.getState().playback) return
  audio.seek(seconds)
  show({ position: Math.max(0, seconds), at: performance.now() })
}

export function toggleShuffle(): void {
  const playback = useNetease.getState().playback
  if (playback) show({ shuffle: !playback.shuffle })
}

/** Off, the whole list, the one song: as NetEase's own button cycles. */
export function cycleRepeat(): void {
  const playback = useNetease.getState().playback
  if (!playback) return
  show({ repeat: playback.repeat === 'off' ? 'all' : playback.repeat === 'all' ? 'one' : 'off' })
}

/** The sound ended: the same song again on repeat one, the next otherwise. */
function songEnded(): void {
  const playback = useNetease.getState().playback
  if (!playback) return
  if (playback.repeat === 'one') {
    audio.seek(0)
    audio.play()
    show({ position: 0, at: performance.now() })
    return
  }
  skip(1)
}

// --- The volume --------------------------------------------------------------------------------------------

/** The player's volume, as it's dragged: shown at once, the sound set to it, kept for the next run. */
export function setVolume(share: number): void {
  const volume = moveVolume(share)
  useNetease.setState({ volume })
  keepVolume(volume)
  audio.setLevel(soundingVolume(volume, useNetease.getState().fade))
}

/** The level a fade holds the sound at (0 to 1), leaving the player's own volume as they set it: the cab fades
 * the music with the game, and quiets it while the truck reverses. */
export function setFade(share: number): void {
  const fade = Math.min(1, Math.max(0, share))
  useNetease.setState({ fade })
  audio.setLevel(soundingVolume(useNetease.getState().volume, fade))
}

/**
 * Lets the fade go: back to the player's own volume.
 *
 * A fade runs while the game is away or the truck reverses, and its last level can outlive the reason for it
 * (a song changed mid-fade, or the cab's quiet ended while the sound was loading). Every change of song calls
 * this, so the next one starts at the volume the player set rather than at whatever the last fade left. The
 * cab calls `setFade` again as soon as it still needs quiet.
 */
/** The ramp running between the fade's two ends, if any. */
let fadeRamp: ReturnType<typeof setInterval> | null = null

/** How long a pause's ramp down, or a play's ramp up, takes, ms (`fadeVolume`). */
const FADE_MS = 1000

/**
 * Moves the fade from where it is to `to` over a second, then runs `done`.
 *
 * The player's volume sits under the fade and is never moved by it (`soundingVolume`), so a pause that
 * ramps to 0 leaves their level exactly as they set it: playing again ramps back up to it rather than to
 * anything new.
 */
/**
 * Drops any fade in progress and puts the sound at the player's own level.
 *
 * A song beginning while a fade runs (pressed pause, then skipped) left the fade half way: `fade` is
 * what `soundingVolume` scales by, so the next song started at almost nothing — it played, and nobody
 * heard it until they pressed play again, which ran `rampFade(1)` and brought it up (owner 2026-11-20).
 */
function endFade(): void {
  if (fadeRamp !== null) clearInterval(fadeRamp)
  fadeRamp = null
  setFade(1)
}

function rampFade(to: number, done?: () => void): void {
  if (fadeRamp !== null) clearInterval(fadeRamp)
  fadeRamp = null
  const from = useNetease.getState().fade
  if (from === to) {
    done?.()
    return
  }
  const started = performance.now()
  fadeRamp = setInterval(() => {
    const gone = (performance.now() - started) / FADE_MS
    if (gone >= 1) {
      if (fadeRamp !== null) clearInterval(fadeRamp)
      fadeRamp = null
      setFade(to)
      done?.()
      return
    }
    // Eased the way `fadeVolume`'s Ramp is: a straight line is audible as a line.
    setFade(to + (from - to) * (1 - gone) ** 2)
  }, 16)
}

export function clearFade(): void {
  // A ramp left running would fight the cab's own fade: it's this app's, so it goes with the rest.
  if (fadeRamp !== null) {
    clearInterval(fadeRamp)
    fadeRamp = null
  }
  if (useNetease.getState().fade === 1) return
  useNetease.setState({ fade: 1 })
  audio.setLevel(soundingVolume(useNetease.getState().volume, 1))
}

/** The player's volume now (0 to 1). */
export function volumeNow(): number {
  return levelOf(useNetease.getState().volume)
}

/** Whether the app plays now. */
export function playingNow(): boolean {
  return useNetease.getState().playback?.playing === true
}

/** Pauses what plays (the game paused, or the truck's electrics off). */
export function pauseNow(): void {
  const playback = useNetease.getState().playback
  if (!playback?.playing) return
  const now = performance.now()
  audio.pause()
  show({ playing: false, position: positionOf(playback, now), at: now })
}

/** Plays on what was paused. */
export function resumeNow(): void {
  const playback = useNetease.getState().playback
  if (!playback || playback.playing) return
  audio.play()
  show({ playing: true, at: performance.now() })
}

// --- The sound's own events ---------------------------------------------------------------------------------

/**
 * What the element tells the app, set as the app opens. The element is the truth of where the song is, so its
 * `timeupdate` moves the bar; a sound that can't play what it was given is the one the service won't give.
 */
export function followSound(): () => void {
  audio.listen({
    playing: () => {
      const playback = useNetease.getState().playback
      if (!playback) return
      // The element plays now: the song's time runs from here (it was held while the sound came).
      if (playback.sound === 'ready' && playback.playing) return
      useNetease.setState({
        playback: { ...playback, playing: true, sound: 'ready', position: playback.sound === 'ready' ? playback.position : 0, at: performance.now() },
      })
    },
    paused: () => {
      const { playback, fade } = useNetease.getState()
      // A fade pauses the sound by itself: the app keeps showing it playing (the cab's own quiet).
      if (!playback?.playing || fade < 1) return
      show({ playing: false, position: positionOf(playback), at: performance.now() })
    },
    time: (seconds) => {
      const playback = useNetease.getState().playback
      if (!playback) return
      // The element is the truth of where the song is: the bar follows it, a quarter second at a time.
      useNetease.setState({ playback: { ...playback, position: seconds, at: performance.now() } })
    },
    ended: () => {
      unsungRun = 0
      songEnded()
    },
    failed: () => {
      const song = currentTrack(useNetease.getState().playback)
      if (song) unsing(song)
    },
    loaded: (seconds) => {
      const playback = useNetease.getState().playback
      if (!playback || !Number.isFinite(seconds) || seconds <= 0) return
      // The sound's own length, where the service's is wrong (a live take, a file cut short).
      if (Math.abs(seconds - playback.duration) > 2) show({ duration: seconds })
    },
    volume: (level) => {
      // The element only echoes what it was given: taken as the player's own, the bar stepped a little with every
      // message — the owner's report against the other players. `hears` keeps their choice the authority, so the
      // one volume the element's echo can move is the one before they've chosen anything.
      const volume = hears(useNetease.getState().volume, level)
      if (volume !== useNetease.getState().volume) useNetease.setState({ volume })
    },
  })
  return () => audio.stop()
}

// --- The account -------------------------------------------------------------------------------------------

/** How long between two looks at a QR sign-in, ms (a phone's confirmation takes a moment). */
const POLL_MS = 2000

let polling: ReturnType<typeof setInterval> | undefined

function stopPolling(): void {
  clearInterval(polling)
  polling = undefined
}

/** Asks the layer who is signed in, and takes the answer. */
export async function refreshAccount(): Promise<void> {
  try {
    const account = await askAccount()
    useNetease.setState({ account })
    // Signing in (or out) changes whose 我喜欢的音乐 it is: the hearts are read again with the account.
    void refreshLiked()
  } catch {
    // The layer didn't answer: the account shows as it was (none, before the first answer).
  }
}

/**
 * Opens a QR sign-in: the layer's key and the address its code holds, shown as a code and looked at every two
 * seconds until the phone confirms it (or the code goes stale).
 */
export async function beginSignIn(): Promise<void> {
  stopPolling()
  useNetease.setState({ signIn: { state: 'asking', url: '', key: '' } })
  let started: SignInStart
  try {
    started = await signInStart()
  } catch {
    useNetease.setState({ signIn: { state: 'failed', url: '', key: '' } })
    return
  }
  useNetease.setState({ signIn: { state: 'waiting', url: started.url, key: started.key } })
  pollSignIn(started.key)
}

function pollSignIn(key: string): void {
  stopPolling()
  polling = setInterval(() => {
    void signInPoll(key).then(
      (answer) => {
        const current = useNetease.getState().signIn
        // A sign-in put away, or another started, while this look was on its way.
        if (!current || current.key !== key) return
        if (answer.state === 'confirmed' || answer.state === 'expired') {
          stopPolling()
          useNetease.setState({ signIn: { ...current, state: answer.state } })
          if (answer.state === 'confirmed') void refreshAccount()
          return
        }
        if (answer.state !== current.state) useNetease.setState({ signIn: { ...current, state: answer.state } })
      },
      // The look didn't get through: the code stands, and the next one asks again.
      () => {},
    )
  }, POLL_MS)
}

/** Puts the QR code away (a sign-in closed, or done). */
export function closeSignIn(): void {
  stopPolling()
  useNetease.setState({ signIn: null })
}

// --- 我喜欢的音乐 ------------------------------------------------------------------------------------------

/**
 * The songs 我喜欢的音乐 holds, asked of the layer once (and kept): what the heart on a song's page reads.
 * Signed out there's nothing to ask, and the list is empty.
 */
export async function refreshLiked(): Promise<void> {
  const signedIn = useNetease.getState().account?.signedIn === true
  if (!signedIn) {
    useNetease.setState({ liked: [] })
    return
  }
  try {
    const answer = await likedSongs()
    useNetease.setState({ liked: answer.liked })
  } catch {
    // The layer didn't answer: the list stays as it was (no heart lit, until it does).
  }
}

/** Whether `id` is in 我喜欢的音乐, as the app knows it now. */
export function isLiked(id: number): boolean {
  return useNetease.getState().liked?.includes(id) === true
}

/**
 * 收藏 a song — the heart on its page — or take it back out.
 *
 * The heart shows the change at once and is put back if the layer won't take it (signed out, or the service
 * refusing): a heart that lit over a song the account didn't get would be a lie. While one is on its way the
 * button is held, so a second press can't send the same song twice.
 */
export async function toggleLiked(id: number): Promise<void> {
  const { liked, liking, account } = useNetease.getState()
  if (liking.includes(id)) return
  if (account?.signedIn !== true) return
  const was = liked?.includes(id) === true
  const next = was ? (liked ?? []).filter((each) => each !== id) : [...(liked ?? []), id]
  useNetease.setState({ liked: next, liking: [...liking, id] })
  try {
    const answer = await setLiked(id, !was)
    if (!answer.ok) useNetease.setState({ liked, liking: liking.filter((each) => each !== id) })
  } catch {
    useNetease.setState({ liked, liking: liking.filter((each) => each !== id) })
  } finally {
    useNetease.setState({ liking: useNetease.getState().liking.filter((each) => each !== id) })
  }
}

/** Signs out: the layer forgets the account, and the app forgets the account's own. */
export async function signOut(): Promise<void> {
  closeSignIn()
  try {
    await signOutAtLayer()
  } catch {
    // The layer didn't answer: it says whose the account still is on the next look.
    return
  }
  useNetease.setState({ account: { signedIn: false, nickname: '', userId: 0, picture: '', vip: false } })
}

// --- The words ---------------------------------------------------------------------------------------------

/**
 * A song's words, asked of the layer once. `null` until they come, and `null` after for a song the service has
 * none for; `failed` says the question didn't get through.
 */
export function useWords(id: number | null): { words: Words | null; failed: boolean } {
  const [asked, setAsked] = useState<{ id: number; words: Words | null; failed: boolean } | null>(null)
  // What's known already, read as it renders rather than written from the effect (a song seen again, after its
  // words came, is drawn with them at once).
  const known = id === null ? undefined : words.get(id)
  useEffect(() => {
    if (id === null || known !== undefined) return
    let current = true
    const pending =
      askingWords.get(id) ??
      lyric(id).then(
        (raw) => {
          const parsed = parseLrc(raw.lrc, raw.translation)
          const found = parsed.lines.length > 0 ? parsed : null
          words.set(id, found)
          askingWords.delete(id)
          return found
        },
        () => {
          askingWords.delete(id)
          throw new Error('the layer has no words for the song')
        },
      )
    askingWords.set(id, pending)
    pending.then(
      (found) => current && setAsked({ id, words: found, failed: false }),
      () => current && setAsked({ id, words: null, failed: true }),
    )
    return () => {
      current = false
    }
  }, [id, known])
  if (id === null) return { words: null, failed: false }
  if (known !== undefined) return { words: known, failed: false }
  return asked && asked.id === id ? { words: asked.words, failed: asked.failed } : { words: null, failed: false }
}

// --- Loading a page ----------------------------------------------------------------------------------------

/** A page's question: its key (the same question shares its answer) and how to ask it. */
export interface Question<T> {
  key: string
  ask(): Promise<T>
}

/**
 * A page's answer: as known this session, else asked now; `null` until it comes, `failed` when it didn't, and
 * `retry` asks again. Another question (a different playlist's page) is asked afresh.
 */
export function useLoad<T>(question: Question<T>): { data: T | null; failed: boolean; retry(): void } {
  const key = question.key
  // A page's answer, once asked, is read as it renders: a page gone back to is drawn with its songs at once,
  // rather than a frame of waiting shapes first.
  const known = answers.get(key) as T | undefined
  const [state, setState] = useState<{ key: string; data: T | null; failed: boolean }>(() => ({
    key,
    data: known ?? null,
    failed: false,
  }))
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (answers.has(key)) return
    let current = true
    question.ask().then(
      (data) => {
        answers.set(key, data)
        if (current) setState({ key, data, failed: false })
      },
      () => current && setState({ key, data: null, failed: true }),
    )
    return () => {
      current = false
    }
    // The key stands for the question; `tries` is the retry, and `question` is asked as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tries])
  const askAgain = () => {
    answers.delete(key)
    setState({ key, data: null, failed: false })
    setTries((n) => n + 1)
  }
  if (known !== undefined) return { data: known, failed: false, retry: askAgain }
  const mine = state.key === key
  return {
    data: mine ? state.data : null,
    failed: mine && state.failed,
    retry: askAgain,
  }
}

// --- The Dashboard's Now Playing --------------------------------------------------------------------------

/**
 * What NetEase Cloud Music plays, as the Dashboard's Now Playing takes music, and its cover; `null` while
 * nothing does. The cover is the song's own album picture, and the controls are the app's own (its `playOrPause`,
 * its `skip`).
 */
export function useNeteaseSource(): { source: import('../../../shared/media').MediaSource; artwork: string | null } | null {
  const playback = useNetease((state) => state.playback)
  const track = currentTrack(playback)
  if (!playback || !track) return null
  return {
    source: {
      id: 'westplay-netease',
      service: 'netease',
      title: track.name,
      artist: track.artists.join(' / '),
      album: track.album,
      artwork: null,
      status: playback.playing ? 'playing' : 'paused',
      positionMs: Math.round(positionOf(playback) * 1000),
      positionAt: Math.round(performance.timeOrigin + playback.at),
      durationMs: playback.duration * 1000,
      controls: { playPause: true, next: true, previous: true, shuffle: true, repeat: true },
      shuffle: playback.shuffle,
      repeat: playback.repeat === 'one' ? 'track' : playback.repeat === 'all' ? 'list' : 'off',
    },
    artwork: track.picture,
  }
}
