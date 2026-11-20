import { type CSSProperties, useEffect, useMemo } from 'react'
import { CheckGlyph, HeartGlyph, MineGlyph, RefreshGlyph, ScanGlyph } from './glyphs'
import { minePlaylists, type MineCollection } from './layer'
import {
  beginSignIn,
  closeSignIn,
  openCollection,
  refreshAccount,
  signOut,
  useLoad,
  useNetease,
} from './netease'
import { Cover, Failed, Shelf, ShelfSkeleton } from './parts'
import { encodeQr, qrExtent, qrPath } from './qr'
import { WORDS } from './words'

/** The sign-in's code for `url`, drawn: the module paths and the box they sit in (`null` for no address). */
function encode(url: string): { path: string; extent: number } | null {
  if (!url) return null
  const symbol = encodeQr(url)
  return { path: qrPath(symbol), extent: qrExtent(symbol) }
}

/**
 * 我的: the account. Signed out, NetEase's QR sign-in — the layer's own key, the address its code holds drawn as
 * a code here (qr.ts), and the phone's answer waited on — and signed in, who it is, with 退出登录.
 */

/** The account's page. */
export function Mine() {
  const account = useNetease((state) => state.account)
  const signIn = useNetease((state) => state.signIn)
  // The account, asked of the layer as the page opens (a sign-in on another run of the app, or one that
  // finished while the page was open).
  useEffect(() => {
    if (!account) void refreshAccount()
  }, [account])
  if (account?.signedIn) return <SignedIn />
  return (
    <div className="ne-scroll ne-mine">
      <header className="ne-mine-head">
        <span className="ne-avatar" aria-hidden="true">
          <MineGlyph on />
        </span>
        <div className="ne-mine-text">
          <h2>{WORDS.signedOut}</h2>
          <p>{WORDS.signedOutHint}</p>
        </div>
      </header>
      {signIn ? <SignInCard /> : <SignInStart />}
    </div>
  )
}

/** Signed out, no code asked for yet: the way in. */
function SignInStart() {
  return (
    <button type="button" className="ne-sign-in-start" onClick={() => void beginSignIn()}>
      <ScanGlyph />
      {WORDS.signIn}
    </button>
  )
}

/** What a QR sign-in says of itself, by its state. */
function stateWords(state: keyof typeof WORDS.signInStates): string {
  return WORDS.signInStates[state]
}

/**
 * The QR code, and the phone's answer as it comes: 等待扫码, 已扫码，请在手机上确认, 登录成功, 二维码已过期 —
 * the last with a fresh code to ask for.
 */
function SignInCard() {
  const signIn = useNetease((state) => state.signIn)
  // The code, encoded once for its address: a QR symbol is a few hundred modules, and the poll's looks (every
  // two seconds) redraw this card without changing the address.
  const code = useMemo(() => encode(signIn?.url ?? ''), [signIn?.url])
  if (!signIn) return null
  const failed = signIn.state === 'expired' || signIn.state === 'failed'
  return (
    <section className={failed ? 'ne-sign-in failed' : 'ne-sign-in'}>
      <div className="ne-qr">
        {code ? (
          // The code's own modules as one path: a phone's reader needs the quiet zone round them.
          <svg viewBox={`0 0 ${code.extent} ${code.extent}`} role="img" aria-label={WORDS.scanTitle}>
            <rect width={code.extent} height={code.extent} fill="#fff" />
            <path d={code.path} fill="#000" />
          </svg>
        ) : (
          <span className="ne-qr-wait" role="progressbar" />
        )}
        {failed && (
          <span className="ne-qr-over" aria-hidden="true">
            <RefreshGlyph />
          </span>
        )}
      </div>
      <div className="ne-sign-in-text">
        <h3>{WORDS.scanTitle}</h3>
        <p className={signIn.state === 'confirmed' ? 'ne-sign-in-state done' : 'ne-sign-in-state'}>
          {signIn.state === 'confirmed' && <CheckGlyph />}
          {stateWords(signIn.state)}
        </p>
        {signIn.state === 'waiting' && <p className="ne-sign-in-hint">{WORDS.scanHint}</p>}
        <div className="ne-sign-in-actions">
          {failed && (
            <button type="button" className="ne-pill" onClick={() => void beginSignIn()}>
              <RefreshGlyph />
              {WORDS.scanAgain}
            </button>
          )}
          {signIn.state === 'confirmed' ? (
            <button
              type="button"
              className="ne-pill"
              onClick={() => {
                // The card goes, and the account is asked for again: 完成 means "I'm signed in", so the
                // page shows it rather than waiting for the tab to be opened again.
                closeSignIn()
                void refreshAccount()
              }}
            >
              {WORDS.done}
            </button>
          ) : (
            !failed && (
              <button type="button" className="ne-pill quiet" onClick={closeSignIn}>
                {WORDS.cancel}
              </button>
            )
          )}
        </div>
      </div>
    </section>
  )
}

/** Signed in: the account's picture and name, its playlists, and 退出登录. */
function SignedIn() {
  const account = useNetease((state) => state.account)!
  const asked = useLoad({ key: 'mine:playlists:signed-in', ask: () => minePlaylists() })
  const all = asked.data?.playlists ?? []
  const loved = all.find((each) => each.loved)
  const mine = all.filter((each) => each.mine)
  const collected = all.filter((each) => each.collected && !each.loved)
  return (
    <div className="ne-scroll ne-mine">
      <header className="ne-mine-head">
        {account.picture ? (
          <span className="ne-avatar">
            <img src={account.picture} alt="" draggable={false} />
          </span>
        ) : (
          <span className="ne-avatar" aria-hidden="true">
            <MineGlyph on />
          </span>
        )}
        <div className="ne-mine-text">
          <h2>{account.nickname || WORDS.member}</h2>
          <p>
            {account.vip && <span className="ne-vip">{WORDS.vip}</span>}
            <span>{WORDS.member}</span>
          </p>
        </div>
        <button type="button" className="ne-pill outline" onClick={() => void signOut()}>
          {WORDS.signOut}
        </button>
      </header>
      {asked.failed ? (
        <Failed onRetry={asked.retry} />
      ) : !asked.data ? (
        <ShelfSkeleton />
      ) : (
        <>
          {loved && <LovedCard collection={loved} />}
          {mine.length > 0 && <Shelf title={WORDS.myPlaylists} collections={mine} onOpen={openCollection} />}
          {collected.length > 0 && (
            <Shelf title={WORDS.collectedPlaylists} collections={collected} onOpen={openCollection} />
          )}
          {!loved && mine.length === 0 && collected.length === 0 && (
            <p className="ne-mine-note">{WORDS.noMinePlaylists}</p>
          )}
        </>
      )}
      <p className="ne-mine-note" style={{ '--none': 0 } as CSSProperties}>
        {account.userId > 0 ? `ID ${account.userId}` : ''}
      </p>
    </div>
  )
}

/** 我喜欢的音乐: the one playlist every account has, drawn as its own wide card above the rest. */
function LovedCard({ collection }: { collection: MineCollection }) {
  return (
    <button type="button" className="ne-loved" onClick={() => openCollection(collection)}>
      <Cover item={{ name: WORDS.loved, picture: collection.picture }} className="ne-loved-cover" />
      <span className="ne-loved-text">
        <span className="ne-loved-name">{WORDS.loved}</span>
        <span className="ne-loved-count">{WORDS.songs(collection.trackCount)}</span>
      </span>
      <span className="ne-loved-mark" aria-hidden="true">
        <HeartGlyph />
      </span>
    </button>
  )
}
