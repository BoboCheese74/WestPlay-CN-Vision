import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from 'react'
import { HeartGlyph, VolumeGlyph } from './glyphs'
// Sized glyphs come from the Music app's own set: NetEase's take no size, and Now Playing's buttons are
// drawn at 36 to 72 px (as QQ Music's are).
import {
  ChevronDownGlyph,
  LyricsGlyph,
  NextGlyph,
  NoteGlyph,
  PauseGlyph,
  PlayGlyph,
  PreviousGlyph,
  QueueGlyph,
  RepeatGlyph,
  RepeatOneGlyph,
  ShuffleGlyph,
} from '../music/glyphs'
import { Cover } from '../music/parts'
import { Crossfade } from '../music/Crossfade'
import { lineAt, type Words } from './lyrics'
import {
  currentTrack,
  cycleRepeat,
  jumpTo,
  openSongAlbum,
  openSongArtist,
  type Playback,
  playOrPause,
  positionOf,
  seek,
  setVolume,
  skip,
  type Song,
  toggleLiked,
  toggleShuffle,
  useNetease,
  useWords,
} from './netease'
import { clock } from './time'
import { WORDS } from './words'

/** A song's cover in the Music app's shape (its `Cover` takes `image`, not `picture`). */
function coverOf(song: Song): { name: string; kind: 'album'; image: string | null; color: string } {
  return { name: song.album || song.name, kind: 'album', image: song.picture || null, color: '#2c2c2e' }
}

/** The app's player: the bar at the foot of the app, and Now Playing over it. */

/**
 * The bar at the foot of the app: the cover, the song and its artists, Play or Pause, and a hairline of its time
 * along the bottom. Pressed, Now Playing rises over the app.
 */
export function MiniPlayer({ aside }: { aside: boolean }) {
  const playback = useNetease((state) => state.playback)
  const open = useNetease((state) => state.nowPlaying)
  const now = useNow(playback?.playing ?? false)
  const track = currentTrack(playback)
  const away = open || aside
  if (!playback || !track) return null
  const share = playback.duration > 0 ? positionOf(playback, now) / playback.duration : 0
  return (
    <div
      className={`am-mini glass${away ? ' away' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={WORDS.nowPlaying}
      onClick={() => useNetease.setState({ nowPlaying: true })}
    >
      <Cover key={track.id} item={coverOf(track)} className="am-mini-cover" />
      <span className="am-mini-text">
        <span className="am-mini-name">{track.name}</span>
        <span className="am-mini-by">{track.artists.join(' / ')}</span>
      </span>
      <button
        type="button"
        className="am-mini-button"
        aria-label={playback.playing ? WORDS.pause : WORDS.play}
        onClick={(event) => {
          event.stopPropagation()
          playOrPause()
        }}
      >
        {playback.playing ? <PauseGlyph size={36} /> : <PlayGlyph size={36} />}
      </button>
      <button
        type="button"
        className="am-mini-button"
        aria-label={WORDS.next}
        onClick={(event) => {
          event.stopPropagation()
          skip(1)
        }}
      >
        <NextGlyph size={38} />
      </button>
      <span
        className={playback.sound === 'loading' ? 'am-mini-time loading' : 'am-mini-time'}
        style={{ '--share': share } as CSSProperties}
      />
    </div>
  )
}

/** The moment the bar draws at: `performance.now()` while a song plays, so the bar keeps moving between
 * the element's own `timeupdate`s (QQ Music's, the same). */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(timer)
  }, [running])
  return now
}


/**
 * What the words sit on in this page (the shape `wordsOver` takes): the blurred cover, faint under the wash
 * the page paints over it. The cover's own share of the colour is small there, so a pale one still reads light
 * enough to want dark words.
 */

export function NowPlaying() {
  const open = useNetease((state) => state.nowPlaying)
  const showLyrics = useNetease((state) => state.lyrics)
  const showQueue = useNetease((state) => state.queue)
  const playback = useNetease((state) => state.playback)
  const track = currentTrack(playback)
  useTicker(playback?.playing ?? false)
  if (!playback || !track) return null
  const close = () => useNetease.setState({ nowPlaying: false })
  const toArtist = () => {
    close()
    openSongArtist(track)
  }
  return (
    <div className={open ? 'am-now ne-app open' : 'am-now ne-app'} aria-hidden={!open}>
      <Crossfade
        value={track.picture}
        className="music-backdrop"
        render={(url) => url && <img src={url} alt="" />}
      />
      <section className="app-panel music-app am-now-panel" aria-label={WORDS.nowPlaying}>
        <div className="music-layout">
          <div className="music-header">
            <button type="button" className="music-corner glass" aria-label={WORDS.close} onClick={close}>
              <ChevronDownGlyph size={34} />
            </button>
            <div className="am-corners">
              <LikeButton song={track} />
              <button
                type="button"
                className={showLyrics ? 'music-corner glass am-on' : 'music-corner glass'}
                aria-label={WORDS.lyrics}
                aria-pressed={showLyrics}
                onClick={() => useNetease.setState({ lyrics: !showLyrics, queue: false })}
              >
                <LyricsGlyph size={32} />
              </button>
              <button
                type="button"
                className={showQueue ? 'music-corner glass am-on' : 'music-corner glass'}
                aria-label={WORDS.queue}
                aria-pressed={showQueue}
                onClick={() => useNetease.setState({ queue: !showQueue, lyrics: false })}
              >
                <QueueGlyph size={32} />
              </button>
            </div>
          </div>

          <div className="music-info">
            <div className="am-now-text">
              <span className="music-title">{track.name}</span>
              <span className="music-artist">
                {track.artists.map((artist, i) => (
                  <span key={`${artist}:${i}`}>
                    {i > 0 && ' / '}
                    {i === 0 && track.artistIds.length > 0 ? (
                      <button type="button" onClick={toArtist}>
                        {artist}
                      </button>
                    ) : (
                      artist
                    )}
                  </span>
                ))}
              </span>
              {track.album && (
                <button
                  type="button"
                  className="music-album"
                  onClick={() => {
                    close()
                    openSongAlbum(track)
                  }}
                >
                  {track.album}
                </button>
              )}
            </div>

            <div className="music-controls">
              <button type="button" className="music-button" aria-label={WORDS.previous} onClick={() => skip(-1)}>
                <PreviousGlyph size={54} />
              </button>
              <button
                type="button"
                className="music-button primary"
                aria-label={playback.playing ? WORDS.pause : WORDS.play}
                onClick={() => playOrPause()}
              >
                {playback.playing ? <PauseGlyph size={72} /> : <PlayGlyph size={72} />}
              </button>
              <button type="button" className="music-button" aria-label={WORDS.next} onClick={() => skip(1)}>
                <NextGlyph size={54} />
              </button>
            </div>
          </div>

          {showQueue ? (
            <Queue playback={playback} />
          ) : showLyrics ? (
            <Words song={track} playback={playback} />
          ) : (
            <div className="music-art">
              {track.picture ? (
                <img src={track.picture} alt="" />
              ) : (
                <div className="music-art-placeholder am-art-drawn" aria-hidden>
                  <NoteGlyph size={72} />
                </div>
              )}
            </div>
          )}

          {playback.sound === 'unplayable' ? <NoRight song={track} /> : <Progress playback={playback} />}

          <div className="music-extras am-extras">
            <button
              type="button"
              className={playback.shuffle ? 'music-button small active' : 'music-button small'}
              aria-label={WORDS.shuffle}
              aria-pressed={playback.shuffle}
              onClick={toggleShuffle}
            >
              <ShuffleGlyph size={36} />
            </button>
            <button
              type="button"
              className={playback.repeat !== 'off' ? 'music-button small active' : 'music-button small'}
              aria-label={WORDS.repeat}
              aria-pressed={playback.repeat !== 'off'}
              onClick={cycleRepeat}
            >
              {playback.repeat === 'one' ? <RepeatOneGlyph size={36} /> : <RepeatGlyph size={36} />}
            </button>
            <Volume />
          </div>
        </div>
      </section>
    </div>
  )
}

function LikeButton({ song }: { song: Song }) {
  const signedIn = useNetease((state) => state.account?.signedIn === true)
  const liked = useNetease((state) => state.liked?.includes(song.id) === true)
  const working = useNetease((state) => state.liking.includes(song.id))
  return (
    <button
      type="button"
      className={`ne-icon ne-like${liked ? ' on' : ''}${working ? ' working' : ''}`}
      aria-label={liked ? WORDS.unlike : WORDS.like}
      aria-pressed={liked}
      title={signedIn ? (liked ? WORDS.unlike : WORDS.like) : WORDS.likeSignedOut}
      disabled={!signedIn || working}
      onClick={() => void toggleLiked(song.id)}
    >
      <HeartGlyph on={liked} />
    </button>
  )
}

/** A song the service won't give here: said in the time bar's place, plainly. */
function NoRight({ song }: { song: Song }) {
  return (
    <p className="ne-unsung" role="status">
      {WORDS.noRightFor(song.name)}
    </p>
  )
}

/** Re-renders while `running`, four times a second: the bar runs on between the sound's own ticks. */
function useTicker(running: boolean): void {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(timer)
  }, [running])
}

/** The player's volume: its speaker (pressed, it silences, or comes back), and its bar. */
function Volume() {
  const volume = useNetease((state) => state.volume.level)
  const bar = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const before = useRef(volume || 0.8)
  const at = (event: PointerEvent) => {
    const box = bar.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
  }
  return (
    <div className="ne-volume">
      <button
        type="button"
        className="ne-icon"
        aria-label={volume === 0 ? WORDS.unmute : WORDS.mute}
        onClick={() => {
          if (volume > 0) {
            before.current = volume
            setVolume(0)
          } else {
            setVolume(before.current)
          }
        }}
      >
        <VolumeGlyph volume={volume} />
      </button>
      <div
        ref={bar}
        className={dragging ? 'ne-bar dragging' : 'ne-bar'}
        role="slider"
        aria-label={WORDS.volume}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(volume * 100)}
        style={{ '--share': volume } as CSSProperties}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
          setVolume(at(event))
        }}
        onPointerMove={(event) => {
          if (dragging) setVolume(at(event))
        }}
        onPointerUp={(event) => {
          if (dragging) setVolume(at(event))
          setDragging(false)
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <span className="ne-bar-fill" />
        <span className="ne-bar-knob" />
      </div>
    </div>
  )
}

/** The song's time: its bar (dragged, it seeks) and the two times under it. */
function Progress({ playback }: { playback: Playback }) {
  const bar = useRef<HTMLDivElement>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const position = dragged ?? positionOf(playback)
  const share = playback.duration > 0 ? position / playback.duration : 0
  const at = (event: PointerEvent) => {
    const box = bar.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * playback.duration
  }
  return (
    <div className="ne-progress">
      <div
        ref={bar}
        className={dragged === null ? 'ne-bar' : 'ne-bar dragging'}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(playback.duration)}
        aria-valuenow={Math.round(position)}
        style={{ '--share': share } as CSSProperties}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragged(at(event))
        }}
        onPointerMove={(event) => {
          if (dragged !== null) setDragged(at(event))
        }}
        onPointerUp={(event) => {
          if (dragged === null) return
          seek(at(event))
          setDragged(null)
        }}
        onPointerCancel={() => setDragged(null)}
      >
        <span className="ne-bar-fill" />
        <span className="ne-bar-knob" />
      </div>
      <div className="ne-times">
        <span>{clock(position)}</span>
        <span>{clock(playback.duration)}</span>
      </div>
    </div>
  )
}

/**
 * The song's words, in the cover's place: the line sung lit and kept in the middle, the ones sung dimmer, the ones
 * to come paler; a line pressed plays the song from it. The translation sits under its own line where the service
 * has one. A song with no words (or words the layer couldn't give) says so.
 */
function Words({ song, playback }: { song: Song; playback: Playback }) {
  const asked = useWords(song.id)
  if (asked.failed) {
    return (
      <div className="am-lyrics-box"><p className="am-lyrics-none">
{WORDS.lyricsFailed}</p></div>
    )
  }
  if (!asked.words) {
    return (
      <div className="am-lyrics-box"><p className="am-lyrics-none">
{WORDS.noLyrics}</p></div>
    )
  }
  return (
    <LyricLines key={song.id} words={asked.words} position={positionOf(playback)} onSeek={seek} />
  )
}

/** How long the reader's own scrolling holds the words where they put them before the song leads them again. */
const HELD = 4000

/**
 * The words themselves: the line sung kept in the card's middle; pressed, the song plays from it.
 *
 * The sung line is centred by its own place in the column, not by the scroller's: its `offsetTop` is measured
 * against the scroller's own content, and half the scroller's seen height taken off it, so it lands in the
 * middle whatever the card's size (a coach's short screen, a wide one). The column's blank first and last
 * stretches (`::before`/`::after`) give the first and last lines the same room, so even they can reach it.
 */
function LyricLines({ words, position, onSeek }: { words: Words; position: number; onSeek(seconds: number): void }) {
  const box = useRef<HTMLDivElement>(null)
  const held = useRef(0)
  const first = useRef(true)
  const current = words.synced ? lineAt(words.lines, position) : -1
  useEffect(() => {
    const scroller = box.current
    if (!scroller || !words.synced || performance.now() < held.current) return
    const line = scroller.querySelectorAll<HTMLElement>('.ne-lyric')[Math.max(0, current)]
    if (!line) return
    // The line sung in the middle of the card.
    const top = line.offsetTop - scroller.clientHeight / 2 + line.offsetHeight / 2
    scroller.scrollTo({ top: Math.max(0, top), behavior: first.current ? 'auto' : 'smooth' })
    first.current = false
  }, [current, words])
  const hold = () => {
    held.current = performance.now() + HELD
  }
  return (
    <div className="am-lyrics-box"><div ref={box} className="am-lyrics" onWheel={hold} onPointerDown={hold}>
      {!words.synced && <p className="ne-lyrics-note">{WORDS.lyricsPlain}</p>}
      {words.lines.map((line, index) => {
        const state = !words.synced ? '' : index === current ? ' now' : index < current ? ' sung' : ''
        const body = (
          <>
            <span className="ne-lyric-text">{line.text || '\u00a0'}</span>
            {line.translation && <span className="ne-lyric-translation">{line.translation}</span>}
          </>
        )
        return words.synced ? (
          <button
            key={index}
            type="button"
            className={`ne-lyric${state}`}
            onClick={() => {
              held.current = 0
              onSeek(line.start)
            }}
          >
            {body}
          </button>
        ) : (
          <p key={index} className={`ne-lyric${state}`}>
            {body}
          </p>
        )
      })}
    </div>
    </div>
  )
}

/** The queue: the song now, then the songs to come from where it plays. Pressed, one plays. */
function Queue({ playback }: { playback: Playback }) {
  const track = currentTrack(playback)!
  const next = playback.tracks.slice(playback.index + 1, playback.index + 14)
  return (
    <div className="ne-queue">
      <h3>{WORDS.nowPlaying}</h3>
      <QueueRow song={track} current />
      {next.length > 0 && <h3>{WORDS.upNext}</h3>}
      {next.map((song, i) => (
        <QueueRow key={`${song.id}:${i}`} song={song} onPlay={() => jumpTo(i + 1)} />
      ))}
    </div>
  )
}

function QueueRow({ song, current = false, onPlay }: { song: Song; current?: boolean; onPlay?(): void }) {
  return (
    <button
      type="button"
      className={current ? 'ne-queue-row current' : 'ne-queue-row'}
      onClick={onPlay}
      disabled={current}
    >
      <Cover item={coverOf(song)} />
      <span className="ne-queue-text">
        <span className="ne-queue-name">{song.name}</span>
        <span className="ne-queue-artists">{song.artists.join(' / ')}</span>
      </span>
    </button>
  )
}
