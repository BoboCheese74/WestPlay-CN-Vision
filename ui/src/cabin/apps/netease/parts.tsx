import type { CSSProperties, ReactNode } from 'react'
import { Equalizer } from './glyphs'
import { coverStyle, type Covered, songCover } from './look'
import { type Collection, type Song, useNetease } from './netease'
import { length } from './time'
import { WORDS } from './words'

/** The pieces the NetEase app's pages share: covers, cards and shelves, rows, and their waiting shapes. */

/**
 * A cover: the service's own picture, or — while it comes, or for something the service has none for — the
 * item's name on the colour its name picks (look.ts), so a shelf is never a row of grey holes.
 */
export function Cover({ item, className = '' }: { item: Covered; className?: string }) {
  const classes = `ne-cover${item.round ? ' round' : ''} ${className}`
  if (item.picture) {
    return (
      <span className={classes}>
        <img src={item.picture} alt="" draggable={false} loading="lazy" />
      </span>
    )
  }
  return (
    <span className={`${classes} drawn`} style={{ '--cover': coverStyle(item.name, 0) } as CSSProperties}>
      <b>{item.name || '♪'}</b>
    </span>
  )
}

/** A card on a shelf: a playlist's or a chart's cover, its name, and how many songs it has. */export function Card({
  collection,
  onOpen,
  kind = 'playlist',
}: {
  collection: Collection
  onOpen(collection: Collection): void
  /** A chart says so above its name. */
  kind?: 'playlist' | 'chart'
}) {
  const count = collection.trackCount || collection.tracks?.length || 0
  return (
    <button type="button" className="ne-card" onClick={() => onOpen(collection)}>
      <Cover item={{ name: collection.name, picture: collection.picture }} />
      {kind === 'chart' && <span className="ne-card-label">{WORDS.chart}</span>}
      <span className="ne-card-name">{collection.name}</span>
      <span className="ne-card-sub">{count > 0 ? WORDS.songs(count) : collection.creator}</span>
    </button>
  )
}

/** A shelf: its title over a row of cards, more to the side; its action (Show all) at the title's end. */
export function Shelf({
  title,
  collections,
  onOpen,
  action,
  kind,
}: {
  title: string
  collections: Collection[]
  onOpen(collection: Collection): void
  action?: ReactNode
  kind?: 'playlist' | 'chart'
}) {
  if (collections.length === 0) return null
  return (
    <section className="ne-section">
      <div className="ne-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      <div className="ne-shelf">
        {collections.map((collection) => (
          <Card key={collection.id} collection={collection} onOpen={onOpen} kind={kind} />
        ))}
      </div>
    </section>
  )
}

/**
 * A song in a list: its number (the bars while it plays), its cover where the list shows one, its name with what
 * it can't do here said beside it, its artists and album, and its length. Pressed, it plays from there.
 */
export function TrackRow({
  song,
  number,
  context,
  cover = false,
  onPlay,
}: {
  song: Song
  /** `null`: no number column (a search's, a chart's top three). */
  number: number | null
  /** The collection it plays from (its rows lift while it's what plays). */
  context: number
  cover?: boolean
  onPlay(): void
}) {
  const { current, playing, noRight } = useNetease((state) => {
    const now = state.playback?.context?.id === context && state.playback ? state.playback.tracks[state.playback.index] : null
    if (now?.id !== song.id) return OTHER
    return state.playback?.sound === 'unplayable' ? UNPLAYABLE : state.playback?.playing ? PLAYING : CURRENT
  })
  const artists = song.artists.join(' / ')
  return (
    <button type="button" className={current ? 'ne-track current' : 'ne-track'} onClick={onPlay}>
      {number !== null && (
        <span className="ne-track-number">{current && !noRight ? <Equalizer playing={playing} /> : number}</span>
      )}
      {cover && <Cover item={songCover(song)} className="ne-track-cover" />}
      <span className="ne-track-text">
        <span className="ne-track-name">
          {song.name}
          {noRight && <span className="ne-track-flag">{WORDS.noRight}</span>}
        </span>
        <span className="ne-track-sub">
          {artists}
          {song.album && <span className="ne-track-album"> · {song.album}</span>}
        </span>
      </span>
      {number === null && current && !noRight && <Equalizer playing={playing} />}
      <span className="ne-track-time">{length(song.duration)}</span>
    </button>
  )
}

const PLAYING = { current: true, playing: true, noRight: false }
const CURRENT = { current: true, playing: false, noRight: false }
const UNPLAYABLE = { current: true, playing: false, noRight: true }
const OTHER = { current: false, playing: false, noRight: false }

/** The service didn't answer: its words, and 重试. */
export function Failed({ onRetry, children }: { onRetry(): void; children?: ReactNode }) {
  return (
    <div className="ne-failed">
      <h2>{WORDS.failed}</h2>
      {children}
      <button type="button" className="ne-pill" onClick={onRetry}>
        {WORDS.tryAgain}
      </button>
    </div>
  )
}

/** A line of a waiting page. */
function Line({ short = false }: { short?: boolean }) {
  return <span className={short ? 'ne-skel-line short' : 'ne-skel-line'} />
}

/** A shelf still coming: its title and a row of cards. */
export function ShelfSkeleton({ count = 5 }: { count?: number }) {
  return (
    <section className="ne-section ne-skeleton" role="progressbar">
      <div className="ne-section-head">
        <span className="ne-skel-line title" />
      </div>
      <div className="ne-shelf">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className="ne-card">
            <span className="ne-cover ne-skel" />
            <Line />
            <Line short />
          </span>
        ))}
      </div>
    </section>
  )
}

/** Songs still coming: their rows. */
export function TracksSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="ne-tracks ne-skeleton" role="progressbar">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="ne-track">
          <span className="ne-track-text">
            <Line />
            <Line short />
          </span>
        </span>
      ))}
    </div>
  )
}

/** A page still coming: its header, then its songs. */
export function PageSkeleton({ round = false }: { round?: boolean }) {
  return (
    <div className="ne-scroll ne-page ne-skeleton" role="progressbar">
      <header className="ne-header">
        <span className={round ? 'ne-cover round ne-header-cover ne-skel' : 'ne-cover ne-header-cover ne-skel'} />
        <span className="ne-header-text">
          <Line short />
          <span className="ne-skel-line big" />
          <Line short />
        </span>
      </header>
      <TracksSkeleton />
    </div>
  )
}

/** A grid of covers still coming (the playlists tab, a search's albums). */
export function GridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="ne-grid ne-skeleton" role="progressbar">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="ne-card">
          <span className="ne-cover ne-skel" />
          <Line />
          <Line short />
        </span>
      ))}
    </div>
  )
}
