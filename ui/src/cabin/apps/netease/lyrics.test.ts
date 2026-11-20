import { describe, expect, it } from 'vitest'
import { lineAt, parseLrc } from './lyrics'

describe('a song’s words', () => {
  it('reads each line’s time and words', () => {
    const words = parseLrc('[00:12.50]First line\n[00:18.05]Second line\n[01:02.9]Third')
    expect(words.synced).toBe(true)
    expect(words.lines.map((line) => line.start)).toEqual([12.5, 18.05, 62.9])
    expect(words.lines.map((line) => line.text)).toEqual(['First line', 'Second line', 'Third'])
  })

  it('gives a line every time its timestamp carries (a chorus sung again)', () => {
    const words = parseLrc('[00:10.00][00:40.00][01:20.00]Chorus\n[00:20.00]Verse')
    expect(words.lines.map((line) => [line.start, line.text])).toEqual([
      [10, 'Chorus'],
      [20, 'Verse'],
      [40, 'Chorus'],
      [80, 'Chorus'],
    ])
  })

  it('reads a fraction of one, two or three digits as what it is', () => {
    expect(parseLrc('[00:01.5]a\n[00:02.25]b\n[00:03.125]c').lines.map((line) => line.start)).toEqual([1.5, 2.25, 3.125])
    // The format's own: two digits are hundredths, so "05" is a twentieth of a second.
    expect(parseLrc('[00:01.05]a').lines[0].start).toBeCloseTo(1.05)
  })

  it('moves every line by the file’s offset', () => {
    const words = parseLrc('[offset:-500]\n[00:10.00]Later\n[00:20.00]Still later')
    expect(words.lines.map((line) => line.start)).toEqual([9.5, 19.5])
  })

  it('never puts a line before the song’s own start', () => {
    expect(parseLrc('[offset:-2000]\n[00:01.00]Soon').lines[0].start).toBe(0)
  })

  it('leaves the tags out of the words', () => {
    const words = parseLrc('[ti:A Song]\n[ar:Someone]\n[al:Somewhere]\n[by:Someone]\n[00:05.00]The words')
    expect(words.lines).toHaveLength(1)
    expect(words.lines[0].text).toBe('The words')
  })

  it('keeps a line with no words as the gap between stanzas', () => {
    const words = parseLrc('[00:05.00]Sung\n[00:09.00]\n[00:14.00]Sung again')
    expect(words.lines.map((line) => line.text)).toEqual(['Sung', '', 'Sung again'])
  })

  it('reads plain words, untimed, in their own order', () => {
    const words = parseLrc('No timing here\nNor here')
    expect(words.synced).toBe(false)
    expect(words.lines.map((line) => line.text)).toEqual(['No timing here', 'Nor here'])
  })

  it('has nothing for a song without words', () => {
    expect(parseLrc('')).toEqual({ synced: false, lines: [] })
    expect(parseLrc('   \n  ').lines).toEqual([])
  })

  it('puts a translation under its own line, and none under a line without one', () => {
    const words = parseLrc(
      '[00:10.00]Hello\n[00:20.00]Goodbye\n[00:30.00]Alone',
      '[00:10.00]你好\n[00:20.00]再见',
    )
    expect(words.lines.map((line) => line.translation)).toEqual(['你好', '再见', null])
  })

  it('still finds a translation timed a little off its line', () => {
    // NetEase's two files are timed alike, but not always to the same millisecond.
    const words = parseLrc('[00:10.00]Hello', '[00:10.20]你好')
    expect(words.lines[0].translation).toBe('你好')
  })

  it('moves the translation by the offset too', () => {
    const words = parseLrc('[offset:-1000]\n[00:10.00]Hello', '[00:10.00]你好')
    expect(words.lines[0].translation).toBe('你好')
  })

  it('reads a Windows file (its carriage returns), and hours too', () => {
    const words = parseLrc('[00:05.00]One\r\n[01:02:03.50]Two')
    expect(words.lines.map((line) => [line.start, line.text])).toEqual([
      [5, 'One'],
      [62 * 60 + 3.5, 'Two'],
    ])
  })
})

describe('the line sung', () => {
  const lines = parseLrc('[00:05.00]One\n[00:10.00]Two\n[00:20.00]Three').lines

  it('is the last one started', () => {
    expect(lineAt(lines, 0)).toBe(-1)
    expect(lineAt(lines, 5)).toBe(0)
    expect(lineAt(lines, 9.99)).toBe(0)
    expect(lineAt(lines, 10)).toBe(1)
    expect(lineAt(lines, 99)).toBe(2)
  })

  it('is none for no lines at all', () => {
    expect(lineAt([], 12)).toBe(-1)
  })
})
