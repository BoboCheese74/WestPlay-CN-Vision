/**
 * Times as NetEase Cloud Music's own app draws them: a song's length beside its name, and the two times under a
 * player's bar. The service sends milliseconds everywhere; the player counts in seconds.
 */

/** `m:ss` from a song's length in milliseconds (as the service sends it): `3:07`. */
export function length(ms: number): string {
  return clock(Math.max(0, Math.round(ms / 1000)))
}

/** `m:ss` from seconds: `0:07`, `12:05`; an hour or more reads `1:02:05`. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  const rest = String(whole % 60).padStart(2, '0')
  if (minutes < 60) return `${minutes}:${rest}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`
}

/** A list of songs' whole minutes (`72_000` ms: 1). */
export function minutes(totalMs: number): number {
  return Math.floor(Math.max(0, totalMs) / 60000)
}
