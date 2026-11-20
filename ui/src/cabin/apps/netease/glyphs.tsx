/** The NetEase app's own symbols: NetEase Cloud Music's shapes, drawn for WestPlay (24-unit grid, rounded ends,
 * a little heavier for the truck's screen). */

/** The app's badge: the note in a ring, as NetEase's own mark is a note in a red round. */
export function NoteGlyph({ on = false }: { on?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {on && <path d="M12 1.6a10.4 10.4 0 1 0 0 20.8 10.4 10.4 0 0 0 0-20.8zm0 2.2a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4z" fill="currentColor" />}
      <path
        d="M10.4 6.6 17 5.2v2.1l-5 1.1v7.4a2.9 2.9 0 1 1-1.6-2.6z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Home: the house, filled while it's the tab. */
export function RecommendGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {on ? (
        <path d="M12 2.6 2.8 10v11.4h6.6v-6.6h5.2v6.6h6.6V10z" fill="currentColor" />
      ) : (
        <path
          d="M12 3.8 3.9 10.3v10h4.7v-6.6h6.8v6.6h4.7v-10z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

/** Playlists: a sleeve with a note on it, as NetEase draws a 歌单's own cover. */
export function PlaylistGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3.2"
        y="3.2"
        width="17.6"
        height="17.6"
        rx="4"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <path
        d={on ? 'M10 8.4 15.6 12 10 15.6z' : 'M10 8.4 15.6 12 10 15.6z'}
        fill={on ? 'var(--ne-base)' : 'currentColor'}
      />
    </svg>
  )
}

/** Charts and radio: bars of an equalizer, filled while it's the tab. */
export function ChartsGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g fill="currentColor" opacity={on ? 1 : 0.95}>
        <rect x="3.2" y="10" width="3.2" height="10.4" rx="1.4" />
        <rect x="8.6" y="4" width="3.2" height="16.4" rx="1.4" />
        <rect x="14" y="7.6" width="3.2" height="12.8" rx="1.4" />
        <rect x="19.4" y="12.4" width="3.2" height="8" rx="1.4" opacity={on ? 1 : 0.6} />
      </g>
    </svg>
  )
}

/** Mine: a person, filled while it's the tab. */
export function MineGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {on ? (
        <>
          <circle cx="12" cy="7.6" r="4.4" fill="currentColor" />
          <path d="M3.6 21.2a8.4 8.4 0 0 1 16.8 0z" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="12" cy="7.6" r="3.6" fill="none" stroke="currentColor" strokeWidth="2.1" />
          <path
            d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  )
}

export function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.8" fill="none" stroke="currentColor" strokeWidth="2.3" />
      <path d="m15.6 15.6 5.4 5.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function BackGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14.6 4.6 7.2 12l7.4 7.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

/** Now Playing put away: the chevron down. */
export function DownGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.8 8.6 12 15.8l7.2-7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 4.3v15.4a1 1 0 0 0 1.5.86l12.6-7.7a1 1 0 0 0 0-1.72L8.5 3.44A1 1 0 0 0 7 4.3z"
        fill="currentColor"
      />
    </svg>
  )
}

export function PauseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5.5" y="3.5" width="4.4" height="17" rx="1.2" fill="currentColor" />
      <rect x="14.1" y="3.5" width="4.4" height="17" rx="1.2" fill="currentColor" />
    </svg>
  )
}

export function NextGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.2 4.4v15.2a.9.9 0 0 0 1.4.76l10.6-7.6a.9.9 0 0 0 0-1.5L6.6 3.7a.9.9 0 0 0-1.4.7z" fill="currentColor" />
      <rect x="18" y="4" width="2.6" height="16" rx="1.1" fill="currentColor" />
    </svg>
  )
}

export function PreviousGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.8 4.4v15.2a.9.9 0 0 1-1.4.76L6.8 12.8a.9.9 0 0 1 0-1.5l10.6-7.6a.9.9 0 0 1 1.4.7z" fill="currentColor" />
      <rect x="3.4" y="4" width="2.6" height="16" rx="1.1" fill="currentColor" />
    </svg>
  )
}

/** Shuffle: two crossing ways, with their arrows. */
export function ShuffleGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 6.5h3.4c1.1 0 2.1.5 2.8 1.4l6.6 8.2c.7.9 1.7 1.4 2.8 1.4H21M3 17.5h3.4c1.1 0 2.1-.5 2.8-1.4l1.3-1.6M14.4 8.4l1.4-1.8c.7-.9 1.7-1.4 2.8-1.4H21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path d="m18.4 2.6 3.2 2.9-3.2 2.9M18.4 14.6l3.2 2.9-3.2 2.9" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Repeat: the two arrows round, a `1` in them for just this song. */
export function RepeatGlyph({ one }: { one: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.4 5.4h9.2a4.4 4.4 0 0 1 4.4 4.4v2.2M17.6 18.6H8.4A4.4 4.4 0 0 1 4 14.2v-2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path d="m9.6 2.6-3.4 2.9 3.4 2.9M14.4 21.4l3.4-2.9-3.4-2.9" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      {one && <text x="12" y="15.6" textAnchor="middle" fontSize="8" fontWeight="800" fill="currentColor">1</text>}
    </svg>
  )
}

export function VolumeGlyph({ volume }: { volume: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.6 9.2h3.2L11.6 5v14l-4.8-4.2H3.6z" fill="currentColor" />
      {volume > 0.02 && (
        <path
          d="M14.8 8.6a4.8 4.8 0 0 1 0 6.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
      {volume > 0.5 && (
        <path
          d="M17.8 6a8.6 8.6 0 0 1 0 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
      {volume <= 0.02 && (
        <path d="m15 9.4 5 5.2M20 9.4l-5 5.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  )
}

export function LyricsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 5.6h16M4 11h11M4 16.4h13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function QueueGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.4 6.4h11M3.4 12h11M3.4 17.6h7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M17 9.4v8.2a2.2 2.2 0 1 1-1.6-2.1z" fill="currentColor" />
    </svg>
  )
}

/** The way a row plays from, and its bars while it does: three bars, rising and falling out of step. */
export function Equalizer({ playing }: { playing: boolean }) {
  return (
    <span className={playing ? 'ne-eq playing' : 'ne-eq'} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

/** A song that can't play here: the service has no right to it. */
export function NoRightGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m6.2 6.2 11.6 11.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** A refresh (the QR code gone stale). */
export function RefreshGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.2 12a8.2 8.2 0 1 1-2.6-6M20.4 4.2v5.6h-5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A check (signed in, or a step of the QR sign-in done). */
export function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m4.6 12.6 5 5.2L19.4 6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A phone scanning a code (the QR sign-in's hint). */
export function ScanGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3.6 8.4V5.4a1.8 1.8 0 0 1 1.8-1.8h3M15.6 3.6h3a1.8 1.8 0 0 1 1.8 1.8v3M20.4 15.6v3a1.8 1.8 0 0 1-1.8 1.8h-3M8.4 20.4h-3a1.8 1.8 0 0 1-1.8-1.8v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path d="M3.6 12h16.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  )
}

/** 我喜欢的音乐: the heart, filled while it's the loved one's card. */
export function HeartGlyph({ on = false }: { on?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20.4 4.7 13.3a4.7 4.7 0 0 1 6.6-6.6l.7.7.7-.7a4.7 4.7 0 0 1 6.6 6.6z"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * NetEase Cloud Music's own mark, as the app's badge: a red round with the white double-note over a disc.
 *
 * NetEase's logo is a white "cloud note" in a red circle: a stylised note (a stem with a flag) over a record's
 * ring. Drawn here rather than shipped as the site's own artwork, as every glyph in this app is.
 */
export function NeteaseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {/* The red round. */}
      <circle cx="12" cy="12" r="11" fill="#e72d2c" />
      {/* The record's ring, as the mark's own disc shows it. */}
      <circle cx="12" cy="12" r="7.6" fill="none" stroke="#fff" strokeWidth="1.5" opacity="0.9" />
      {/* The note: a stem and its flag, over the ring. */}
      <path
        d="M13.9 6.5v8.1a2.5 2.5 0 1 1-1.5-2.3V8.1l4.4-1v2.2z"
        fill="#fff"
      />
      <path d="M9.2 17.9h5.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" opacity="0.9" />
    </svg>
  )
}
