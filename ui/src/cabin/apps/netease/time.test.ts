import { describe, expect, it } from 'vitest'
import { clock, length, minutes } from './time'

describe('a song’s length', () => {
  it('reads as minutes and seconds, the service’s milliseconds rounded', () => {
    expect(length(0)).toBe('0:00')
    expect(length(7_400)).toBe('0:07')
    expect(length(187_000)).toBe('3:07')
    expect(length(187_600)).toBe('3:08')
    expect(length(59_999)).toBe('1:00')
  })

  it('never reads below zero, whatever the service sends', () => {
    expect(length(-1_000)).toBe('0:00')
  })

  it('reads an hour or more with its hours', () => {
    expect(length(3_725_000)).toBe('1:02:05')
  })
})

describe('a time in seconds', () => {
  it('counts the player’s own clock', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65.9)).toBe('1:05')
    expect(clock(725)).toBe('12:05')
  })

  it('holds at zero before the song starts', () => {
    expect(clock(-3)).toBe('0:00')
  })
})

describe('a list’s minutes', () => {
  it('counts whole minutes of its songs', () => {
    expect(minutes(0)).toBe(0)
    expect(minutes(59_999)).toBe(0)
    expect(minutes(60_000)).toBe(1)
    expect(minutes(72 * 60_000 + 30_000)).toBe(72)
  })
})
