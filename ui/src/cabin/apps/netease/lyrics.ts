/**
 * A song's words as NetEase Cloud Music sends them: LRC, the plain text-and-timings format, with the app's own
 * two extras (a translation as a second LRC, and an `[offset:...]` shift).
 *
 * The parser is here rather than in the view because the words are the app's hardest small thing to get right:
 * a line may carry several timestamps (a chorus's repeat), a timestamp's fraction may be one, two or three
 * digits, a file may mix timed and untimed lines, and the service's own `[offset:±ms]` moves every line of it.
 */

/** A line of the words: when it's sung, what it says, and what it says translated. */
export interface LyricLine {
  /** Seconds into the song. */
  start: number
  text: string
  /** The line's translation, when the service has one for it. */
  translation: string | null
}

/** A song's words. */
export interface Words {
  /** `false` when the file had no timings at all (plain words): nothing is highlighted then. */
  synced: boolean
  lines: LyricLine[]
}

/** `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]`, `[mm:ss.xxx]`, and the same with hours before (`[hh:mm:ss.xx]`). */
const STAMP = /\[(?:(\d{1,3}):)?(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g

/** `[offset:-500]`: milliseconds added to every line's time (a positive one moves them later). */
const OFFSET = /\[offset:\s*([+-]?\d+)\s*\]/i

/** `[ti:...]`, `[ar:...]`, `[al:...]`, `[by:...]` and the rest: a file's own tags, not words. */
const TAG = /^\[[a-z#]+:.*\]$/i

/** How far a translation's line may sit from the words' own and still be that line's, in seconds (the service
 * times the two files alike, but not always to the same millisecond). */
const MATCH = 0.5

/** One row of a file: its timestamps in seconds (none for a plain line), and the words after them. */
function rowOf(row: string): { stamps: number[]; text: string } {
  const stamps: number[] = []
  const pattern = new RegExp(STAMP.source, STAMP.flags)
  let last = 0
  for (let match = pattern.exec(row); match; match = pattern.exec(row)) {
    // An hour counts sixty minutes of them.
    const hours = match[1] ? Number(match[1]) * 60 : 0
    const fraction = match[4] ? Number(`0.${match[4]}`) : 0
    stamps.push(hours * 60 + Number(match[2]) * 60 + Number(match[3]) + fraction)
    last = pattern.lastIndex
  }
  return { stamps, text: row.slice(last) }
}

/** The file's offset in seconds (`[offset:...]`, 0 without one). */
function offsetOf(lrc: string): number {
  const match = OFFSET.exec(lrc)
  return match ? Number(match[1]) / 1000 : 0
}

/** A file's timed rows, each stamped once per timestamp it carries, in time order; `shift` moves them all (the
 * translation's file, which carries no offset of its own, takes the words' own). */
function timings(lrc: string, shift = offsetOf(lrc)): { start: number; text: string }[] {
  const found: { start: number; text: string }[] = []
  for (const row of lrc.split(/\r\n|\r|\n/)) {
    const trimmed = row.trim()
    if (!trimmed || TAG.test(trimmed) || OFFSET.test(trimmed)) continue
    const { stamps, text } = rowOf(row)
    for (const at of stamps) found.push({ start: Math.max(0, at + shift), text: text.trim() })
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Whether a file has any timing at all. */
function hasTimings(lrc: string): boolean {
  return lrc.split(/\r\n|\r|\n/).some((row) => rowOf(row).stamps.length > 0)
}

/**
 * The words of a song, from its LRC and the translation the service sends beside it (`''` when there is none).
 * A translation's line is the words' line at its own time (`MATCH`), so a line without one has `null`; a line
 * with no words is kept as it is (the music between stanzas). Untimed words (a file with no timings at all) are
 * one line each, in the file's order, and `synced` is false.
 */
export function parseLrc(lrc: string, translation = ''): Words {
  if (!lrc.trim()) return { synced: false, lines: [] }
  const offset = offsetOf(lrc)
  const translated = translation.trim() ? timings(translation, offset) : []
  if (!hasTimings(lrc)) {
    const lines = lrc
      .split(/\r\n|\r|\n/)
      .map((row) => row.trim())
      .filter((row) => row && !TAG.test(row) && !OFFSET.test(row))
      .map((text) => ({ start: 0, text, translation: null }))
    return { synced: false, lines }
  }
  const lines = timings(lrc).map(({ start, text }) => ({
    start,
    text,
    translation: translated.find((line) => Math.abs(line.start - start) <= MATCH)?.text ?? null,
  }))
  return { synced: true, lines }
}

/** The line of the words sung at `position` (seconds): the last one started, -1 before the first. */
export function lineAt(lines: readonly { start: number }[], position: number): number {
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle].start <= position) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}
