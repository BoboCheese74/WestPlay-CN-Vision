import { useEffect, useState } from 'react'
import { TextField } from '../../keyboard/TextField'
import {
  album as askAlbum,
  artist as askArtist,
  minePlaylists,
  type MineCollection,
  playlist as askPlaylist,
  recommendPlaylists,
  recommendSongs,
  search as askSearch,
  toplists,
  type Artist,
  type Collection,
  type SearchResults,
  type Song,
} from './layer'
import { HeartGlyph, PauseGlyph, PlayGlyph, SearchGlyph } from './glyphs'
import {
  openAlbum,
  openArtist,
  openCollection,
  playFrom,
  playOrPause,
  playSong,
  shufflePlay,
  useLoad,
  useNetease,
  type PlayContext,
  type View,
} from './netease'
import { Card, Cover, Failed, GridSkeleton, Shelf, ShelfSkeleton, TrackRow, TracksSkeleton } from './parts'
import { minutes } from './time'
import { WORDS } from './words'

/** The app's pages: the four tabs' own, the pages over them, and the search's results. */

/** The search field's id (the keyboard types into one field at a time). */
export const FIELD = 'netease-search'

/** A page over a tab's own. */
export function Page({ view }: { view: View }) {
  switch (view.kind) {
    case 'playlist':
      return (
        <CollectionPage
          kind="playlist"
          id={view.id}
          name={view.name}
          picture={view.picture}
          creator={view.creator}
        />
      )
    case 'album':
      return <CollectionPage kind="album" id={view.id} name={view.name} picture={view.picture} creator={view.artist} />
    case 'artist':
      return <ArtistPage id={view.id} name={view.name} picture={view.picture} />
    case 'results':
      return <Results query={view.query} />
  }
}

// --- 推荐 ---------------------------------------------------------------------------------------------------

/** 推荐: the account's own playlists down the left, and the day's songs and picks beside them. */
export function Recommend() {
  const songs = useLoad({ key: 'recommend:songs', ask: () => recommendSongs().then((answer) => answer.songs) })
  const playlists = useLoad({
    key: 'recommend:playlists',
    ask: () => recommendPlaylists().then((answer) => answer.playlists),
  })
  // The account's collected playlists, down the left: nothing to show while signed out, and nothing asked then.
  const signedIn = useNetease((state) => state.account?.signedIn === true)
  // The key carries the sign-in: a signed-out first look answers nothing, and it must not be kept as the answer
  // once the account has been read (which is what left the column empty after a sign-in).
  const mine = useLoad({
    key: signedIn ? 'mine:playlists:signed-in' : 'mine:playlists:signed-out',
    ask: () => (signedIn ? minePlaylists() : Promise.resolve({ playlists: [], signedIn: false })),
  })
  const collected = signedIn ? (mine.data?.playlists ?? []) : []
  // The day the card shows: read once as the page opens, not on every redraw (a redraw isn't a new day).
  const [day] = useState(today)
  const daily = songs.data
  const dailyContext: PlayContext = { kind: 'search', id: 0, name: WORDS.dailySongs }
  return (
    <div className={collected.length > 0 ? 'ne-scroll ne-home with-side' : 'ne-scroll ne-home'}>
      {collected.length > 0 && <SidePlaylists collections={collected} />}
      <div className="ne-home-main">
        <section className="ne-daily">
          <header className="ne-daily-head">
            <div className="ne-daily-date" aria-hidden="true">
              <b>{day}</b>
            </div>
            <div className="ne-daily-text">
              <h2>{WORDS.dailySongs}</h2>
              <p>{WORDS.dailyHint}</p>
            </div>
            {daily && daily.length > 0 && (
              <button
                type="button"
                className="ne-play"
                aria-label={WORDS.playAll}
                onClick={() => playFrom(dailyContext, daily, 0)}
              >
                <PlayGlyph />
              </button>
            )}
          </header>
          {songs.failed ? (
            <Failed onRetry={songs.retry} />
          ) : !daily ? (
            <TracksSkeleton count={6} />
          ) : daily.length === 0 ? (
            <p className="ne-empty">{WORDS.empty}</p>
          ) : (
            <div className="ne-tracks">
              {daily.slice(0, 12).map((song, index) => (
                <TrackRow
                  key={song.id}
                  song={song}
                  number={index + 1}
                  context={0}
                  onPlay={() => playFrom(dailyContext, daily, index)}
                />
              ))}
            </div>
          )}
        </section>
        {playlists.failed ? (
          <Failed onRetry={playlists.retry} />
        ) : !playlists.data ? (
          <ShelfSkeleton />
        ) : (
          <Shelf title={WORDS.recommendedPlaylists} collections={playlists.data} onOpen={openCollection} />
        )}
      </div>
    </div>
  )
}

/**
 * The account's playlists down the left of 推荐: 我喜欢的音乐 first (it's the one every account has), then the
 * ones it made, then the ones it collected — each a row, the one playing marked. A signed-out page has no
 * column at all (the caller draws none), and a failed question leaves it to the next look rather than breaking
 * the page it stands beside.
 */
function SidePlaylists({ collections }: { collections: MineCollection[] }) {
  const loved = collections.filter((each) => each.loved)
  const own = collections.filter((each) => each.mine)
  const collected = collections.filter((each) => each.collected && !each.loved)
  const groups: { title: string; items: MineCollection[] }[] = [
    { title: WORDS.myPlaylists, items: [...loved, ...own] },
    { title: WORDS.collectedPlaylists, items: collected },
  ]
  return (
    <aside className="ne-home-side" aria-label={WORDS.myPlaylists}>
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section key={group.title} className="ne-side-group">
            <h3 className="ne-side-title">{group.title}</h3>
            <div className="ne-side-list">
              {group.items.map((collection) => (
                <SideRow key={collection.id} collection={collection} />
              ))}
            </div>
          </section>
        ))}
    </aside>
  )
}

/** One of the account's playlists, as the left column's row: its cover, its name, and how many songs it has. */
function SideRow({ collection }: { collection: MineCollection }) {
  const playing = useNetease((state) => state.playback?.context?.id === collection.id && state.playback.playing)
  const count = collection.trackCount || collection.tracks?.length || 0
  return (
    <button
      type="button"
      className={playing ? 'ne-side-row playing' : 'ne-side-row'}
      onClick={() => openCollection(collection)}
    >
      <Cover
        item={{
          name: collection.loved ? WORDS.loved : collection.name,
          picture: collection.picture,
        }}
        className="ne-side-cover"
      />
      <span className="ne-side-text">
        <span className="ne-side-name">{collection.loved ? WORDS.loved : collection.name}</span>
        <span className="ne-side-sub">
          {count > 0 ? WORDS.songs(count) : collection.creator || WORDS.kinds.playlist}
        </span>
      </span>
      {collection.loved && (
        <span className="ne-side-heart" aria-hidden="true">
          <HeartGlyph on />
        </span>
      )}
    </button>
  )
}

/** The day of the month the daily card shows, read as the page opens (a redraw isn't a new day). */
function today(): number {
  return new Date().getDate()
}

// --- 歌单 ---------------------------------------------------------------------------------------------------

/** 歌单: the playlists recommended for the player, as cards, each opened to its songs. */
export function Playlists() {
  const asked = useLoad({
    key: 'recommend:playlists',
    ask: () => recommendPlaylists().then((answer) => answer.playlists),
  })
  if (asked.failed) {
    return (
      <div className="ne-scroll">
        <Failed onRetry={asked.retry} />
      </div>
    )
  }
  return (
    <div className="ne-scroll">
      <h2 className="ne-page-title">{WORDS.recommendedPlaylists}</h2>
      <p className="ne-page-note">{WORDS.recommendedHint}</p>
      {!asked.data ? (
        <GridSkeleton />
      ) : (
        <div className="ne-grid">
          {asked.data.map((collection) => (
            <Card key={collection.id} collection={collection} onOpen={openCollection} />
          ))}
        </div>
      )}
    </div>
  )
}

// --- 电台·榜单 --------------------------------------------------------------------------------------------

/** 电台·榜单: every chart the service keeps, each opened to its songs. */
export function Channels() {
  const asked = useLoad({ key: 'toplists', ask: () => toplists().then((answer) => answer.toplists) })
  if (asked.failed) {
    return (
      <div className="ne-scroll">
        <Failed onRetry={asked.retry} />
      </div>
    )
  }
  return (
    <div className="ne-scroll">
      <h2 className="ne-page-title">{WORDS.charts}</h2>
      <p className="ne-page-note">{WORDS.chartsHint}</p>
      {!asked.data ? (
        <GridSkeleton count={12} />
      ) : (
        <div className="ne-grid">
          {asked.data.map((collection) => (
            <Card key={collection.id} collection={collection} onOpen={openCollection} kind="chart" />
          ))}
        </div>
      )}
    </div>
  )
}

// --- A playlist's, a chart's or an album's page ------------------------------------------------------------

/** Both routes answer alike: a collection and its songs (the album's route done the playlist's way). */
function askCollection(kind: 'playlist' | 'album', id: number): Promise<{ collection: Collection; tracks: Song[] }> {
  return kind === 'playlist' ? askPlaylist(id) : askAlbum(id)
}

/**
 * A playlist's, a chart's or an album's page: its header, the big Play with Shuffle, and its songs in their order.
 * The header shows what was pressed at once (its name and cover) while the songs come, so the page never opens on
 * a shape with nothing in it.
 */
function CollectionPage({
  kind,
  id,
  name,
  picture,
  creator,
}: {
  kind: 'playlist' | 'album'
  id: number
  name: string
  picture: string
  /** A playlist's curator, an album's artist. */
  creator: string
}) {
  const asked = useLoad({ key: `${kind}:${id}`, ask: () => askCollection(kind, id) })
  const page = asked.data
  const collection = page?.collection
  const tracks = page?.tracks ?? []
  const shown = collection?.name || name
  const by = (collection && (collection.creator || collection.artist)) || creator
  const context: PlayContext = { kind, id, name: shown }
  return (
    <div className="ne-scroll ne-page">
      <header className="ne-header">
        <Cover item={{ name: shown, picture: collection?.picture || picture }} className="ne-header-cover" />
        <div className="ne-header-text">
          <span className="ne-header-kind">{WORDS.kinds[kind]}</span>
          <h2 className={`ne-header-name ${titleSize(shown)}`}>{shown}</h2>
          {collection?.description && <p className="ne-header-description">{collection.description}</p>}
          <p className="ne-header-meta">
            {by && <span className="ne-owner">{by}</span>}
            {collection && <span>{WORDS.songs(tracks.length)}</span>}
            {tracks.length > 0 && <span>{WORDS.minutes(minutes(total(tracks)))}</span>}
          </p>
        </div>
      </header>
      {asked.failed ? (
        <Failed onRetry={asked.retry} />
      ) : !page ? (
        <TracksSkeleton />
      ) : (
        <>
          <div className="ne-actions">
            <BigPlay context={context} tracks={tracks} />
            <button type="button" className="ne-pill outline" onClick={() => shufflePlay(context, tracks)}>
              {WORDS.shuffle}
            </button>
          </div>
          <div className="ne-tracks">
            {tracks.length === 0 ? (
              <p className="ne-empty">{WORDS.empty}</p>
            ) : (
              tracks.map((song, index) => (
                <TrackRow
                  key={`${song.id}:${index}`}
                  song={song}
                  number={index + 1}
                  context={id}
                  onPlay={() => playFrom(context, tracks, index)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** The big play a page's header has: it plays the page, and pauses it while the page is what plays. */
function BigPlay({ context, tracks }: { context: PlayContext; tracks: Song[] }) {
  const playing = useNetease((state) => Boolean(state.playback?.context?.id === context.id && state.playback.playing))
  return (
    <button
      type="button"
      className="ne-play"
      aria-label={playing ? WORDS.pause : WORDS.playAll}
      onClick={() => playOrPause(context, tracks)}
    >
      {playing ? <PauseGlyph /> : <PlayGlyph />}
    </button>
  )
}

/** A list's whole length, milliseconds. */
function total(tracks: readonly Song[]): number {
  return tracks.reduce((sum, song) => sum + song.duration, 0)
}

/** A name's size: a short one huge, a long one smaller (as NetEase sizes its own page titles). */
function titleSize(name: string): string {
  return name.length <= 12 ? 'huge' : name.length <= 22 ? 'large' : 'long'
}

// --- An artist's page --------------------------------------------------------------------------------------

/** An artist's page: their picture, and their most played songs. */
function ArtistPage({ id, name, picture }: { id: number; name: string; picture: string }) {
  const asked = useLoad({ key: `artist:${id}`, ask: () => askArtist(id) })
  const page = asked.data
  if (asked.failed) {
    return (
      <div className="ne-scroll">
        <Failed onRetry={asked.retry} />
      </div>
    )
  }
  if (!page) {
    return (
      <div className="ne-scroll ne-page">
        <header className="ne-header artist">
          <Cover item={{ name, picture, round: true }} className="ne-header-cover" />
          <div className="ne-header-text">
            <span className="ne-header-kind">{WORDS.kinds.artist}</span>
            <h2 className={`ne-header-name ${titleSize(name)}`}>{name}</h2>
          </div>
        </header>
        <TracksSkeleton />
      </div>
    )
  }
  const artist: Artist = page.artist
  const tracks = page.tracks
  const context: PlayContext = { kind: 'artist', id: artist.id, name: artist.name }
  return (
    <div className="ne-scroll ne-page">
      <header className="ne-header artist">
        <Cover item={{ name: artist.name, picture: artist.picture, round: true }} className="ne-header-cover" />
        <div className="ne-header-text">
          <span className="ne-header-kind">{WORDS.kinds.artist}</span>
          <h2 className={`ne-header-name ${titleSize(artist.name)}`}>{artist.name}</h2>
          {tracks.length > 0 && (
            <p className="ne-header-meta">
              <span>{WORDS.songs(tracks.length)}</span>
            </p>
          )}
        </div>
      </header>
      {tracks.length > 0 && (
        <div className="ne-actions">
          <BigPlay context={context} tracks={tracks} />
          <button type="button" className="ne-pill outline" onClick={() => shufflePlay(context, tracks)}>
            {WORDS.shuffle}
          </button>
        </div>
      )}
      <div className="ne-tracks">
        {tracks.length === 0 ? (
          <p className="ne-empty">{WORDS.empty}</p>
        ) : (
          tracks.map((song, index) => (
            <TrackRow
              key={`${song.id}:${index}`}
              song={song}
              number={index + 1}
              context={artist.id}
              onPlay={() => playFrom(context, tracks, index)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// --- The search's results -----------------------------------------------------------------------------------

/** A search's results: its songs, then its playlists, artists and albums, each under its own heading. */
function Results({ query }: { query: string }) {
  const asked = useLoad({ key: `search:${query}`, ask: () => askSearch(query) })
  const results: SearchResults | null = asked.data
  if (asked.failed) {
    return (
      <div className="ne-scroll">
        <Failed onRetry={asked.retry} />
      </div>
    )
  }
  if (!results) {
    return (
      <div className="ne-scroll">
        <h2 className="ne-page-title">{WORDS.searchFor(query)}</h2>
        <TracksSkeleton />
      </div>
    )
  }
  const empty = results.songs.length + results.playlists.length + results.artists.length + results.albums.length === 0
  if (empty) {
    return (
      <div className="ne-scroll ne-nothing">
        <h2>{WORDS.noResults}</h2>
        <p>{WORDS.noResultsHint}</p>
      </div>
    )
  }
  const context: PlayContext = { kind: 'search', id: 0, name: WORDS.searchFor(query) }
  return (
    <div className="ne-scroll">
      <h2 className="ne-page-title">{WORDS.searchFor(query)}</h2>
      {results.songs.length > 0 && (
        <section className="ne-section">
          <div className="ne-section-head">
            <h3>
              {WORDS.groups.songs} <small>{results.songs.length}</small>
            </h3>
          </div>
          <div className="ne-tracks">
            {results.songs.map((song, index) => (
              <TrackRow
                key={song.id}
                song={song}
                number={index + 1}
                context={0}
                onPlay={() => playFrom(context, results.songs, index)}
              />
            ))}
          </div>
        </section>
      )}
      {results.playlists.length > 0 && (
        <Shelf title={WORDS.groups.playlists} collections={results.playlists} onOpen={openCollection} />
      )}
      {results.artists.length > 0 && (
        <section className="ne-section">
          <div className="ne-section-head">
            <h3>{WORDS.groups.artists}</h3>
          </div>
          <div className="ne-shelf">
            {results.artists.map((artist) => (
              <button
                key={artist.id}
                type="button"
                className="ne-card"
                onClick={() => openArtist({ id: artist.id, name: artist.name, picture: artist.picture })}
              >
                <Cover item={{ name: artist.name, picture: artist.picture, round: true }} />
                <span className="ne-card-name">{artist.name}</span>
                <span className="ne-card-sub">{WORDS.kinds.artist}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {results.albums.length > 0 && (
        <Shelf title={WORDS.groups.albums} collections={results.albums} onOpen={openAlbumCard} />
      )}
    </div>
  )
}

/** An album's card pressed: its page, with the card's own artist (the album's route names it anyway). */
function openAlbumCard(album: Collection): void {
  openAlbum(album)
}

/** As the player types: the songs found, asked after a pause in the typing. */
export function Typing({ query, onPicked }: { query: string; onPicked(): void }) {
  const [asked, setAsked] = useState(query.trim())
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const none: SearchResults = { songs: [], playlists: [], artists: [], albums: [], total: 0 }
  const results = useLoad({
    key: `search:${asked}`,
    ask: () => (asked ? askSearch(asked) : Promise.resolve(none)),
  })
  const songs: Song[] = results.data?.songs ?? []
  const context: PlayContext = { kind: 'search', id: 0, name: WORDS.searchFor(asked) }
  if (!query.trim()) return null
  return (
    <div className="ne-scroll">
      {results.failed ? (
        <Failed onRetry={results.retry} />
      ) : !results.data ? (
        <TracksSkeleton count={6} />
      ) : (
        <div className="ne-tracks">
          {songs.slice(0, 8).map((song) => (
            <TrackRow
              key={song.id}
              song={song}
              number={null}
              context={0}
              cover
              onPlay={() => {
                playSong(song, songs, context)
                onPicked()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// --- The top bar's search field ----------------------------------------------------------------------------

/** The search field, as the top bar draws it (the same field the search layer types into). */
export function SearchField({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange(value: string): void
  onSubmit(): void
}) {
  return (
    <TextField
      id={FIELD}
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      returnKind="search"
      hint={WORDS.searchHint}
      label={WORDS.search}
      icon={<SearchGlyph />}
    />
  )
}
