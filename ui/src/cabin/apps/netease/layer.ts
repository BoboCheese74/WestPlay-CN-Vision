import { type PageMessage, isInHost, postToHost, subscribeHostMessages } from '../../../shared/host'

/**
 * The page's side of NetEase Cloud Music's local layer: the routes it answers, over the loopback, as JSON.
 *
 * The layer is a process of WestPlay's own (crates/host netease_layer.rs) with the account's cookie in it and
 * nowhere else, so the page never sees a credential: it asks the layer for songs, and the layer asks the
 * service. Which port the layer came up on is the host's to say; the app asks once as it opens and takes what
 * the host answers, with `LAYER_PORT` as the layer's own default for a page outside the host (a plain browser
 * preview, or a layer a player started by hand).
 */

/** The port the layer answers on when nothing says otherwise. */
export const DEFAULT_PORT = 8788

/** The port the app talks to: the host's, once it has said; [`DEFAULT_PORT`] until then. */
let layerPort = DEFAULT_PORT

/** A place the layer answers on, as its routes' base. */
export function layerBase(port = layerPort): string {
  return `http://127.0.0.1:${port}`
}

/** The port the layer answers on now. */
export function currentPort(): number {
  return layerPort
}

/** Talks to the layer at `port` from now on (the host's answer, or a player's own layer). */
export function setLayerPort(port: number | null): void {
  layerPort = port ?? DEFAULT_PORT
}

// --- The shapes the layer answers with ----------------------------------------------------------------------

/** A song, as every route that has songs gives them. */
export interface Song {
  id: number
  name: string
  artists: string[]
  artistIds: number[]
  album: string
  albumId: number
  picture: string
  /** Milliseconds. */
  duration: number
  /** NetEase's own: 0 free, 1 VIP, 4 paid, 8 a low-quality free one; `null` not said. */
  fee: number | null
}

/** A playlist or an album, as the search, the recommendations and the charts give them. */
export interface Collection {
  id: number
  kind: 'playlist' | 'album'
  name: string
  picture: string
  description: string
  trackCount: number
  creator: string
  /** The charts' own first page of songs (the route has them already). */
  tracks?: Song[]
  /** An album's artist (the album's route says it). */
  artist?: string
}

/** An artist, as a search gives one. */
export interface Artist {
  id: number
  kind: 'artist'
  name: string
  picture: string
}

/** What a search found. */
export interface SearchResults {
  songs: Song[]
  playlists: Collection[]
  artists: Artist[]
  albums: Collection[]
  /** How many songs the service has for it (`0` when it doesn't say). */
  total: number
}

/** What the layer says of its account. */
export interface Account {
  signedIn: boolean
  nickname: string
  userId: number
  picture: string
  vip: boolean
}

/** One of the account's playlists: its own, one it collected, or 我喜欢的音乐 (`loved`). */
export interface MineCollection extends Collection {
  /** Made by the account itself. */
  mine: boolean
  /** Someone else's, collected. */
  collected: boolean
  /** 我喜欢的音乐: the one every account has. */
  loved: boolean
}

/** A song's words, as the service sends them: two LRC files, the second often empty. */
export interface RawLyrics {
  lrc: string
  translation: string
}

/** Where a song's audio is (`url` empty, or `code` -110: no right to it). */
export interface AudioSource {
  url: string
  bitrate: number
  size: number
  code: number | null
}

/** The QR sign-in's key, and the address its code holds. */
export interface SignInStart {
  key: string
  url: string
}

/** How a QR sign-in stands: waiting, scanned (to confirm on the phone), confirmed, or gone stale. */
export type SignInState = 'waiting' | 'scanned' | 'confirmed' | 'expired'

export interface SignInPoll {
  state: SignInState
  code: number
}

// --- Asking -------------------------------------------------------------------------------------------------

/** How long a route has to answer before it's taken as failed, ms (the layer's own call takes up to 20 s). */
const TIMEOUT = 25000

/** What went wrong, as the app says it: the layer is down, or it answered a route with a failure. */
export class LayerError extends Error {
  /** Whether the layer couldn't be reached at all (its process not running, or its port wrong). */
  readonly down: boolean

  constructor(message: string, down: boolean) {
    super(message)
    this.name = 'LayerError'
    this.down = down
  }
}

/** A route's answer, as JSON, with `what` for a failure's words. */
async function ask<T>(route: string, init?: RequestInit, what = route): Promise<T> {
  let answer: Response
  try {
    answer = await fetch(`${layerBase()}${route}`, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
  } catch {
    throw new LayerError(`${what}: the layer didn't answer`, true)
  }
  if (!answer.ok) throw new LayerError(`${what}: ${answer.status}`, false)
  try {
    return (await answer.json()) as T
  } catch {
    throw new LayerError(`${what}: not JSON`, false)
  }
}

/** A route's answer for a `POST` with a JSON body. */
function post<T>(route: string, body: unknown, what = route): Promise<T> {
  return ask<T>(
    route,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    what,
  )
}

/** `GET /api/health`: whether the layer is up, and whether an account is signed in. */
export function health(): Promise<{ ok: boolean; signedIn: boolean; nickname: string; userId: number }> {
  return ask('/api/health')
}

/** `GET /api/search`: songs, playlists, artists and albums for `words`. */
export function search(words: string, limit = 30, offset = 0): Promise<SearchResults> {
  const query = new URLSearchParams({ s: words, type: '1', limit: String(limit), offset: String(offset) })
  return ask(`/api/search?${query}`)
}

/** `GET /api/song`: one song as the service has it now (its album's picture, its fee). */
export function song(id: number): Promise<{ songs: Song[] }> {
  return ask(`/api/song?id=${id}`)
}

/** `POST /api/songs`: several songs at once (a chart's own list, a playlist's). */
export function songs(ids: readonly number[]): Promise<{ songs: Song[] }> {
  return post('/api/songs', { ids })
}

/** `GET /api/lyric`: the words and their translation. */
export function lyric(id: number): Promise<RawLyrics> {
  return ask(`/api/lyric?id=${id}`)
}

/** `GET /api/url`: where a song's audio is, at `br` bits a second (320 kbps by default). */
export function url(id: number, br = 320000): Promise<AudioSource> {
  return ask(`/api/url?id=${id}&br=${br}`)
}

/** `GET /api/toplists`: every chart, each with its first page of songs. */
export function toplists(): Promise<{ toplists: Collection[] }> {
  return ask('/api/toplists')
}

/** `GET /api/playlist`: a playlist and all its songs. */
export function playlist(id: number): Promise<{ collection: Collection; tracks: Song[] }> {
  return ask(`/api/playlist?id=${id}`)
}

/** `GET /api/album`: an album and its songs. */
export function album(id: number): Promise<{ collection: Collection; tracks: Song[] }> {
  return ask(`/api/album?id=${id}`)
}

/** `GET /api/artist`: an artist and their most played songs. */
export function artist(id: number): Promise<{ artist: Artist; tracks: Song[] }> {
  return ask(`/api/artist?id=${id}`)
}

/** `GET /api/recommend/songs`: the day's own songs. */
export function recommendSongs(): Promise<{ songs: Song[] }> {
  return ask('/api/recommend/songs')
}

/** `GET /api/recommend/playlists`: playlists picked for the player. */
export function recommendPlaylists(): Promise<{ playlists: Collection[] }> {
  return ask('/api/recommend/playlists')
}

/** `GET /api/account`: who is signed in, with their picture. */
export function account(): Promise<Account> {
  return ask('/api/account')
}

/** `GET /api/mine/playlists`: the account's own playlists and the ones it collected. */
export function minePlaylists(): Promise<{ playlists: MineCollection[]; signedIn: boolean }> {
  return ask('/api/mine/playlists')
}

/** `GET /api/mine/liked`: every song 我喜欢的音乐 holds (what the heart on a song reads). */
export function likedSongs(): Promise<{ liked: number[]; signedIn: boolean }> {
  return ask('/api/mine/liked')
}

/** `POST /api/mine/like`: 收藏 a song into 我喜欢的音乐, or take it back out. */
export function setLiked(id: number, liked: boolean): Promise<{ ok: boolean; liked: boolean; reason?: string }> {
  return post('/api/mine/like', { id, liked })
}

/** `POST /api/signin/start`: the QR sign-in's key, and the address its code holds. */
export function signInStart(): Promise<SignInStart> {
  return post('/api/signin/start', {})
}

/** `POST /api/signin/poll`: how a QR sign-in stands. */
export function signInPoll(key: string): Promise<SignInPoll> {
  return post('/api/signin/poll', { key })
}

/** `POST /api/signout`: forget the account. */
export function signOut(): Promise<{ ok: boolean }> {
  return post('/api/signout', {})
}

// --- The layer's port --------------------------------------------------------------------------------------

/**
 * Asks the host where the layer is, and takes its answer from then on. The host answers a `netease` message
 * with the port, or `null` when the layer isn't running; a page outside the host has no one to ask, and keeps
 * [`DEFAULT_PORT`]. Returns the unsubscribe function.
 */
export function followLayerPort(): () => void {
  if (!isInHost()) return () => {}
  const stop = subscribeHostMessages((message) => {
    if (message.type === 'netease') setLayerPort(message.port)
  })
  askPort()
  return stop
}

/**
 * The page's ask for the layer's port, and for the layer to forget the account. The host takes both already
 * (`crates/host/src/lib.rs`: `PageMessage::NeteasePort`, `NeteaseSignOut`), but `shared/host.ts`'s `PageMessage`
 * doesn't name them yet — another change is in flight in that file. Each is posted with its own shape written
 * here, and goes through `postToHost` as the file gains the variants; nothing else in the app casts.
 */
const ASK_PORT = { type: 'neteasePort' } as const
const ASK_SIGN_OUT = { type: 'neteaseSignOut' } as const

function postNetease(message: typeof ASK_PORT | typeof ASK_SIGN_OUT): void {
  postToHost(message as unknown as PageMessage)
}

/** Asks the host for the layer's port (it answers a `netease` message). */
export function askPort(): void {
  postNetease(ASK_PORT)
}

/** Asks the host to have the layer forget the account (the layer is also told over the loopback). */
export function askSignOut(): void {
  postNetease(ASK_SIGN_OUT)
}
