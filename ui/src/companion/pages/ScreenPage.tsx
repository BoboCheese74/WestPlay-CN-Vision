import { useContext, useState } from 'react'
import { GAME_KINDS, GAME_NAMES } from '../setup'
import { setWestplayOpen } from '../useHostStatus'
import { Group, Note, Panel, Row, Status, Switch, Tick } from '../room/parts'
import { banner, RoomText } from '../room/room'
import { GLOW, useScreenAt } from '../room/screen'
import { type PageProps, screenState } from './page'
import type { CoachSpeakers } from '../useSettings'

/**
 * The truck's screen: where WestPlay is now (its headline), WestPlay on it or the truck's own, and the
 * connection from WestPlay to the game to the screen. On the room's screen, Home, and WestPlay saying the
 * same in a banner.
 */
export function ScreenPage({ status, settings, setup, cw }: PageProps) {
  const w = cw.screen
  const state = screenState(status)
  // Known once the cabin page has said (it owns the state): the switch waits for it.
  const open = status?.westplayOpen ?? null
  useScreenAt(
    state === 'original' ? 'dashboard' : 'home',
    GLOW.home,
    state === 'live'
      ? banner(w.banners.live)
      : state === 'original'
        ? banner(w.banners.original)
        : state === 'unsupported'
          ? banner(w.banners.unsupported)
          : state === 'notInCab'
            ? banner(w.banners.notInCab)
            : state === 'noGame'
              ? banner(w.banners.noGame, true)
              : null,
  )
  const fps = status?.framesPerSecond ?? 0
  // The game connected; else the games set up (else both).
  const kinds = status?.game ? [status.game] : setup.games.length ? setup.games.map((game) => game.kind) : GAME_KINDS
  const gameName = kinds.map((kind) => GAME_NAMES[kind]).join(' · ')
  return (
    <Panel place="page" title={w.titles[state]} sub={w.subs[state]}>
      <Group place={4}>
        <Row
          title={w.show}
          detail={w.showDetail}
          accessory={
            <Switch
              on={open ?? false}
              disabled={open === null || !status?.screenDrawing}
              label={w.show}
              change={(on) => {
                setWestplayOpen(on).catch((error: unknown) => console.error('WestPlay could not be switched', error))
              }}
            />
          }
        />
      </Group>
      <Group title={w.connection} place={5}>
        <Row
          title={w.engine}
          value={status?.error ? cw.values.failed : status ? w.engineRunning : w.engineStarting}
          accessory={<Status tone={status?.error ? 'bad' : status ? 'good' : 'busy'} />}
        />
        <Row
          title={gameName}
          value={status?.gameConnected ? w.gameConnected : w.gameNotRunning}
          accessory={<Status tone={status?.gameConnected ? 'good' : 'idle'} />}
        />
        <Row
          title={w.truckScreen}
          value={
            state === 'unsupported'
              ? w.screenUnsupported
              : status?.screenDrawing
                ? w.screenLive.replace('{fps}', String(fps))
                : w.screenNotInView
          }
          accessory={
            <Status
              tone={
                state === 'unsupported'
                  ? 'idle'
                  : status?.screenDrawing
                    ? 'good'
                    : status?.gameConnected
                      ? 'busy'
                      : 'idle'
              }
            />
          }
        />
      </Group>
      {status?.gameElevated && (
        <Note tone="bad">
          <b>{w.elevated.title}</b> {w.elevated.text}
        </Note>
      )}
      <DisplayFirst settings={settings} cw={cw} />
      <MobileWebUi status={status} settings={settings} />
      <CoachChooser status={status} settings={settings} cw={cw} />
      <GpuChooser status={status} settings={settings} cw={cw} />
      {status?.error && <Note tone="bad">{status.error}</Note>}
    </Panel>
  )
}

function MobileWebUi({ status, settings: state }: Pick<PageProps, 'status' | 'settings'>) {
  const { settings, update, error } = state
  const zh = useContext(RoomText).locale.startsWith('zh')
  const [copiedUrl, setCopiedUrl] = useState('')
  const [copyFailedUrl, setCopyFailedUrl] = useState('')
  if (!settings) return null
  const title = zh ? '手机远程车机（Mobile WebUI）' : 'Mobile WebUI'
  const enabled = settings.mobileWebUi
  const service = status?.mobileWebUi
  const running = enabled && service?.state === 'running'
  const urls = running ? service.pairingUrls : []
  const busy = enabled && (!service || service.state === 'off')
  return (
    <Group place={9}>
      <Row
        title={title}
        detail={
          zh
            ? '通过同一可信局域网内的手机浏览器查看和触控车机。'
            : 'View and control the cab in a phone browser on a trusted local network.'
        }
        wrap
        accessory={<Switch on={enabled} label={title} change={(on) => void update({ ...settings, mobileWebUi: on })} />}
      />
      {busy && <Note>{zh ? '正在启动局域网服务…' : 'Starting the LAN service…'}</Note>}
      {enabled && service?.state === 'error' && (
        <Note tone="bad">
          {zh
            ? '局域网服务不可用（TCP 8765）。如端口被占用，请释放端口后关闭再开启。'
            : 'LAN service unavailable (TCP 8765). If the port is in use, free it and turn the switch off and on.'}{' '}
          {service.message}
        </Note>
      )}
      {running && urls.length === 0 && (
        <Note>
          {zh
            ? '暂未找到可访问的局域网 IPv4 地址。连接 Wi-Fi 后关闭再开启。'
            : 'No private IPv4 address found. Connect to Wi-Fi and turn the switch off and on.'}
        </Note>
      )}
      {urls.map((url) => (
        <div key={url}>
          <Row
            title={new URL(url).origin}
            detail={
              copiedUrl === url
                ? zh
                  ? '已复制配对链接'
                  : 'Pairing link copied'
                : zh
                  ? '点击复制配对链接'
                  : 'Click to copy the pairing link'
            }
            onClick={() => {
              setCopyFailedUrl('')
              navigator.clipboard.writeText(url).then(
                () => setCopiedUrl(url),
                () => setCopyFailedUrl(url),
              )
            }}
          />
          {copyFailedUrl === url && (
            <input
              aria-label={zh ? '配对链接' : 'Pairing link'}
              readOnly
              value={url}
              onFocus={(event) => event.target.select()}
            />
          )}
        </div>
      ))}
      {urls.length > 0 && (
        <Note>
          {zh
            ? '复制与手机同网的地址，在手机上打开完整配对链接。请勿分享链接。'
            : 'Copy the link for the network your phone is on and open it on your phone. Keep the link private.'}
        </Note>
      )}
      {error && <Note tone="bad">{error}</Note>}
    </Group>
  )
}

/**
 * Which of the cab's two screens WestPlay fills first: the truck's own (off, as it always did, WestPlay's tablet
 * then staying blank in a truck whose own screen shows WestPlay), or WestPlay's tablet (on: the truck's own screens
 * keep the game's own). The plugin keeps whichever the player didn't name as the game's own, per frame
 * (`crates/plugin/src/screens.rs`, the bridge's `tablet_first`).
 */
function DisplayFirst({ settings: state, cw }: Pick<PageProps, 'settings' | 'cw'>) {
  const w = cw.screen
  const { settings, update } = state
  if (!settings) return null
  return (
    <Group title={w.display} place={6}>
      <Row
        title={w.displayFirst}
        detail={w.displayFirstDetail}
        accessory={
          <Switch
            on={settings.screen.tabletFirst}
            label={w.displayFirst}
            change={(on) => void update({ ...settings, screen: { ...settings.screen, tabletFirst: on } })}
          />
        }
      />
    </Group>
  )
}

/**
 * The graphics card WestPlay's screen is drawn on: WestPlay's pick (the game's), or one the player chooses
 * when that one stutters, as iOS lists choices (a tick on the chosen, as the onboarding's game folders). The
 * one drawing it now says so; a choice starts WestPlay's screen again on that card. Only with more than one
 * card to choose from.
 */
function GpuChooser({ status, settings: state, cw }: Pick<PageProps, 'status' | 'settings' | 'cw'>) {
  const w = cw.screen
  const { settings, update } = state
  const adapters = status?.adapters ?? []
  if (!settings || adapters.length < 2) return null
  const chosen = adapters.some((adapter) => adapter.id === settings.graphics.gpu) ? settings.graphics.gpu : null
  const choose = (gpu: string | null) => {
    if (gpu !== settings.graphics.gpu) void update({ ...settings, graphics: { gpu } })
  }
  return (
    <>
      <Group title={cw.about.gpu} place={7}>
        <Row
          title={w.gpuAuto}
          detail={w.gpuAutoDetail}
          accessory={chosen === null ? <Tick key="auto" /> : undefined}
          onClick={() => choose(null)}
        />
        {adapters.map((adapter) => (
          <Row
            key={adapter.id}
            title={adapter.name}
            detail={adapter.name === status?.cabAdapter ? w.gpuInUse : undefined}
            accessory={chosen === adapter.id ? <Tick key={adapter.id} /> : undefined}
            onClick={() => choose(adapter.id)}
          />
        ))}
      </Group>
      <Note tone="calm">{w.gpuNote}</Note>
    </>
  )
}

/**
 * Which of a coach's speakers play (owner 2026-11-13): the driver's pair round the seat, or every unit over the
 * passengers' seats, as real coaches have a cockpit system and a passengers' one. A choice here, not in the cab; the
 * passengers' are many speakers at once, which a weak processor feels, so the note under it says how many in the coach
 * driven (its own count, from the host). Greyed out outside a coach (owner 2026-11-13).
 */
function CoachChooser({ status, settings: state, cw }: Pick<PageProps, 'status' | 'settings' | 'cw'>) {
  const w = cw.screen
  const { settings, update } = state
  if (!settings) return null
  const chosen = settings.sound.coach
  const count = status?.coachSpeakers ?? null
  const off = count === null
  const choose = (coach: CoachSpeakers) => {
    if (coach !== chosen) void update({ ...settings, sound: { ...settings.sound, coach } })
  }
  return (
    <>
      <Group title={w.coachSpeakers} place={7} disabled={off}>
        <Row
          title={w.coachDriver}
          detail={w.coachDriverDetail}
          accessory={chosen === 'driver' ? <Tick key="driver" /> : undefined}
          onClick={() => choose('driver')}
        />
        <Row
          title={w.coachPassengers}
          detail={w.coachPassengersDetail}
          accessory={chosen === 'passengers' ? <Tick key="passengers" /> : undefined}
          onClick={() => choose('passengers')}
        />
      </Group>
      <Note tone="calm" disabled={off}>
        {off ? w.coachNoteAny : w.coachNote.replace('{n}', String(count))}
      </Note>
    </>
  )
}
