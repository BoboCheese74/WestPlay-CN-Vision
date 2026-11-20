import { describe, expect, it } from 'vitest'
import { encodeQr, qrExtent, qrPath } from './qr'

/**
 * Two symbols as this encoder makes them, each checked the way a phone reads one: drawn out, and decoded by an
 * independent reader (zxing-cpp), which gave back exactly the text below. They're held here rather than asked of
 * a library, because the encoder's own job is to be right; a change that breaks a symbol breaks these first.
 */
const GOLDEN = [
  {
    text: 'HELLO',
    version: 1,
    mask: 4,
    rows: [
      '111111101101001111111',
      '100000100110101000001',
      '101110100111101011101',
      '101110101001001011101',
      '101110101000101011101',
      '100000101011001000001',
      '111111101010101111111',
      '000000001111100000000',
      '100010111111011111001',
      '000111001011100101111',
      '101100101011001110010',
      '111001000100011010000',
      '001011100100111000110',
      '000000001110111001011',
      '111111101100110001010',
      '100000100001100100010',
      '101110101001001110101',
      '101110100001100001011',
      '101110100111001111000',
      '100000100100011000000',
      '111111101000111110101',
    ],
  },
  {
    text: 'https://music.163.com/login?codekey=2b1f0c8e4a',
    version: 4,
    mask: 6,
    rows: [
      '111111101110001000101110101111111',
      '100000101011000011010010001000001',
      '101110101000100011111111101011101',
      '101110100111000000010100001011101',
      '101110101111111100101000101011101',
      '100000100011011000001101001000001',
      '111111101010101010101010101111111',
      '000000000001010000011000000000000',
      '100111111000101111010010110010111',
      '001001000000001100110001000011100',
      '010101110001101111100101001011111',
      '011110010110101101011001110100111',
      '010000100000111011101110101000010',
      '000011011001010011010001010001100',
      '110110100110110010000110101101100',
      '010010010010001100110000110011101',
      '010110101000101010011000111110000',
      '000110000000010110111100001010101',
      '000011100011101110010001001101101',
      '011100011010010111101101110011101',
      '010000110110010000011100010101000',
      '101010000001111011101011110110000',
      '100110101111100110000011010110111',
      '101100000010101011000010110011101',
      '110101101010100110011011111110000',
      '000000001101110110100011100010110',
      '111111101010010100110111101010100',
      '100000101100001010010001100011101',
      '101110101110111001111101111110011',
      '101110101000101001001000110100001',
      '101110100100111010001010100110111',
      '100000100100111110000010011110111',
      '111111101010100011000011110111000',
    ],
  },
] as const

/** A symbol as its rows of "1" and "0" (1: dark). */
function rowsOf(text: string, mask: number): string[] {
  return encodeQr(text, mask).modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}

describe('the QR encoder', () => {
  for (const golden of GOLDEN) {
    it(`draws ${golden.text} as a phone reads it`, () => {
      const symbol = encodeQr(golden.text, golden.mask)
      expect(symbol.version).toBe(golden.version)
      expect(symbol.size).toBe(17 + 4 * golden.version)
      expect(rowsOf(golden.text, golden.mask)).toEqual([...golden.rows])
    })
  }

  it('picks the smallest version that holds the text', () => {
    expect(encodeQr('A').version).toBe(1)
    // Version 1 holds 16 data codewords at level M, less the mode's and the count's 12 bits: 14 bytes.
    expect(encodeQr('x'.repeat(14)).version).toBe(1)
    expect(encodeQr('x'.repeat(15)).version).toBe(2)
    expect(encodeQr('x'.repeat(120)).version).toBeGreaterThan(4)
  })

  it('keeps the symbol square, its quiet zone around it', () => {
    const symbol = encodeQr('HELLO')
    expect(symbol.modules).toHaveLength(symbol.size)
    for (const row of symbol.modules) expect(row).toHaveLength(symbol.size)
    expect(qrExtent(symbol)).toBe(symbol.size + 8)
    expect(qrExtent(symbol, 0)).toBe(symbol.size)
    expect(qrPath(symbol, 0)).not.toContain('M-')
  })

  it('draws a dark square for each of its dark modules, and no light ones', () => {
    const symbol = encodeQr('HELLO')
    const dark = symbol.modules.flat().filter(Boolean).length
    const squares = qrPath(symbol).split('z').length - 1
    expect(squares).toBe(dark)
  })

  it('refuses text a version 10 symbol cannot hold', () => {
    // Version 10 holds 216 data codewords at level M, less the mode's and the count's 20 bits: 213 bytes.
    expect(encodeQr('x'.repeat(213)).version).toBe(10)
    expect(() => encodeQr('x'.repeat(214))).toThrow(/beyond 10/)
  })

  it('holds the finders’ three corners and their timing lines in every mask', () => {
    for (let mask = 0; mask < 8; mask++) {
      const rows = rowsOf('https://music.163.com/login?codekey=2b1f0c8e4a', mask)
      const size = rows.length
      // The top left finder's own 7 x 7, and the timing lines' alternating modules between the finders.
      for (let i = 0; i < 7; i++) {
        expect(rows[i].slice(0, 7)).toBe(['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'][i])
        expect(rows[i].slice(size - 7)).toBe(
          ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'][i],
        )
      }
      for (let i = 8; i < size - 8; i++) expect(rows[6][i]).toBe(i % 2 === 0 ? '1' : '0')
    }
  })
})
