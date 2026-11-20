/**
 * A QR encoder of the app's own (no dependency: the page ships whole, and a sign-in code is all it is for).
 *
 * Byte mode only, error correction level M, versions 1 to 10: a sign-in link is a short URL, and a version 10
 * symbol holds 216 bytes of it. Everything else is ISO/IEC 18004's: the finder and timing patterns, the
 * alignment patterns, the format and version information, the error correction's codewords, and the mask chosen
 * by the standard's penalty. Written out rather than left to a library, because a code a phone can't read is a
 * sign-in nobody can finish.
 */

/** A symbol to draw: its modules, `true` for a dark one, and how it was made. */
export interface QrSymbol {
  /** 1 to 10: the symbol is `17 + 4 * version` modules square. */
  version: number
  /** The mask pattern used (0 to 7). */
  mask: number
  /** Modules square, the quiet zone around it not counted. */
  size: number
  /** `modules[row][column]`. */
  modules: boolean[][]
}

/**
 * Per version (1 to 10, index 0 unused) at error level M, each block group's
 * `[blocks, codewords per block, data codewords per block]` (the rest of each block is its error correction).
 * From the standard's tables.
 */
const BLOCKS: readonly (readonly (readonly number[])[])[] = [
  [],
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
]

/** The alignment pattern centres, by version (a symbol of 21 modules has none but the corners'). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** The most version this makes: beyond it a link isn't worth the page's code. */
const MOST_VERSION = 10

/** The standard's four penalty weights: a run, a block, a finder-like pattern, a dark share far from half. */
const PENALTY: readonly [number, number, number, number] = [3, 3, 40, 10]

/** Multiplication in GF(256), by the tables of the powers of 2 (its primitive polynomial 0x11d). */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x = x << 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

/** The data codewords a version holds at level M (`0` for one it doesn't make). */
function dataCodewords(version: number): number {
  return BLOCKS[version].reduce((sum, [blocks, , data]) => sum + blocks * data, 0)
}

/** The smallest version a payload of `bytes` needs: its header (mode, count) and its bytes, in a whole symbol. */
function versionFor(bytes: number): number {
  for (let version = 1; version <= MOST_VERSION; version++) {
    // The character count is 8 bits below version 10, 16 from it.
    const header = 4 + (version < 10 ? 8 : 16)
    if (header + bytes * 8 <= dataCodewords(version) * 8) return version
  }
  throw new Error(`a QR code of ${bytes} bytes needs a version beyond ${MOST_VERSION}`)
}

/** The generator polynomial of `degree` error codewords, its coefficients from the highest power (always 1). */
function generator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** `data`'s error codewords: the remainder of its division by `gen`, as the standard's Reed-Solomon asks. */
function errorCodewords(data: readonly number[], gen: readonly number[]): number[] {
  const rest = new Array<number>(gen.length - 1).fill(0)
  for (const byte of data) {
    const factor = byte ^ rest[0]
    rest.shift()
    rest.push(0)
    for (let i = 0; i < rest.length; i++) rest[i] ^= mul(gen[i + 1], factor)
  }
  return rest
}

/** The symbol's codewords: the payload, its blocks' error codewords, interleaved as the standard orders them. */
function codewords(text: string, version: number): number[] {
  const bytes = new TextEncoder().encode(text)
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) put(byte, 8)
  // The terminator, the bits to a whole byte, and the two bytes the standard pads with.
  put(0, Math.min(4, dataCodewords(version) * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0))
  }
  for (let pad = 0; data.length < dataCodewords(version); pad++) data.push(pad % 2 === 0 ? 0xec : 0x11)

  const blocks: { data: number[]; error: number[] }[] = []
  let at = 0
  for (const [count, size, dataSize] of BLOCKS[version]) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + dataSize)
      at += dataSize
      blocks.push({ data: block, error: errorCodewords(block, generator(size - dataSize)) })
    }
  }
  const out: number[] = []
  const longest = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  }
  const mostErrors = Math.max(...blocks.map((block) => block.error.length))
  for (let i = 0; i < mostErrors; i++) {
    for (const block of blocks) if (i < block.error.length) out.push(block.error[i])
  }
  return out
}

/** Where each module is (`dark`), and which are the symbol's own rather than the payload's (`fixed`). */
interface Grid {
  dark: boolean[][]
  fixed: boolean[][]
}

function blank(version: number): Grid {
  const size = 17 + 4 * version
  return {
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  }
}

function set(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.dark[y][x] = dark
  grid.fixed[y][x] = true
}

/** A finder pattern's centre at `(x, y)`, with its light separator all round (cut at the symbol's edge). */
function finder(grid: Grid, x: number, y: number): void {
  const size = grid.dark.length
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const far = Math.max(Math.abs(dx), Math.abs(dy))
      const atX = x + dx
      const atY = y + dy
      if (atX < 0 || atY < 0 || atX >= size || atY >= size) continue
      set(grid, atX, atY, far !== 2 && far !== 4)
    }
  }
}

/** The 5 x 5 alignment pattern centred at `(x, y)`. */
function alignment(grid: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) set(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
}

/** The symbol's own patterns, drawn before its payload: the areas the payload must go round. */
function patterns(version: number): Grid {
  const grid = blank(version)
  const size = grid.dark.length
  // The timing lines first: the finders' corners cover their ends.
  for (let i = 0; i < size; i++) {
    set(grid, 6, i, i % 2 === 0)
    set(grid, i, 6, i % 2 === 0)
  }
  finder(grid, 3, 3)
  finder(grid, size - 4, 3)
  finder(grid, 3, size - 4)
  const centres = ALIGNMENT[version]
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      // The three corners are the finders' own.
      if ((i === 0 && j === 0) || (i === 0 && j === centres.length - 1) || (i === centres.length - 1 && j === 0)) {
        continue
      }
      alignment(grid, centres[i], centres[j])
    }
  }
  // The module that is always dark, and the room kept for the format and version information.
  set(grid, 8, size - 8, true)
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserve(grid, 8, i)
      reserve(grid, i, 8)
    }
  }
  for (let i = 0; i < 8; i++) {
    reserve(grid, size - 1 - i, 8)
    reserve(grid, 8, size - 1 - i)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      reserve(grid, size - 11 + (i % 3), Math.floor(i / 3))
      reserve(grid, Math.floor(i / 3), size - 11 + (i % 3))
    }
  }
  return grid
}

function reserve(grid: Grid, x: number, y: number): void {
  grid.fixed[y][x] = true
}

/** The payload's bits, from the bottom right upwards in pairs of columns, round the patterns. */
function placeData(grid: Grid, codewords: readonly number[]): void {
  const size = grid.dark.length
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the timing line: the pairs step over it.
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - step : step
        if (grid.fixed[y][x] || bit >= codewords.length * 8) continue
        grid.dark[y][x] = ((codewords[bit >> 3] >> (7 - (bit & 7))) & 1) === 1
        bit++
      }
    }
  }
}

/** Whether a mask turns the module at `(x, y)` over: the eight patterns the standard defines. */
function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/** The 15 bits of the format: level M's own (0), the mask, and the standard's error correction over them. */
function formatBits(mask: number): number {
  let value = mask // Level M is 00 above the mask's three bits.
  let rest = value
  for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >> 9) * 0x537)
  return ((value << 10) | rest) ^ 0x5412
}

/** The 18 bits of the version: its number and the standard's error correction over it. */
function versionBits(version: number): number {
  let rest = version
  for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >> 11) * 0x1f25)
  return (version << 12) | rest
}

function bitAt(value: number, at: number): boolean {
  return ((value >> at) & 1) !== 0
}

/** The format's two copies: beside the top left finder, and split along the others. */
function drawFormat(grid: Grid, mask: number): void {
  const size = grid.dark.length
  const bits = formatBits(mask)
  for (let i = 0; i <= 5; i++) set(grid, 8, i, bitAt(bits, i))
  set(grid, 8, 7, bitAt(bits, 6))
  set(grid, 8, 8, bitAt(bits, 7))
  set(grid, 7, 8, bitAt(bits, 8))
  for (let i = 9; i < 15; i++) set(grid, 14 - i, 8, bitAt(bits, i))
  for (let i = 0; i < 8; i++) set(grid, size - 1 - i, 8, bitAt(bits, i))
  for (let i = 8; i < 15; i++) set(grid, 8, size - 15 + i, bitAt(bits, i))
  // The dark module, written again (a format copy's edge may have cleared it).
  set(grid, 8, size - 8, true)
}

function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return
  const size = grid.dark.length
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    set(grid, a, b, bitAt(bits, i))
    set(grid, b, a, bitAt(bits, i))
  }
}

/** The standard's penalty: long runs, blocks, finder-like patterns, and a dark share far from half. */
function penalty(dark: readonly boolean[][]): number {
  const size = dark.length
  const run = (get: (i: number) => boolean): number => {
    let score = 0
    let length = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) {
        length++
        continue
      }
      if (length >= 5) score += PENALTY[0] + (length - 5)
      length = 1
    }
    return score
  }
  let score = 0
  for (let i = 0; i < size; i++) {
    score += run((at) => dark[i][at])
    score += run((at) => dark[at][i])
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = dark[y][x]
      if (dark[y][x + 1] === colour && dark[y + 1][x] === colour && dark[y + 1][x + 1] === colour) {
        score += PENALTY[1]
      }
    }
  }
  // A finder's shape with four light modules beside it, either way round, in a row or a column.
  const first = [true, false, true, true, true, false, true, false, false, false, false]
  const second = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = (get: (at: number) => boolean, at: number, pattern: readonly boolean[]): boolean => {
    for (let i = 0; i < pattern.length; i++) if (get(at + i) !== pattern[i]) return false
    return true
  }
  for (let i = 0; i < size; i++) {
    for (let at = 0; at + 11 <= size; at++) {
      for (const pattern of [first, second]) {
        if (matches((x) => dark[i][x], at, pattern)) score += PENALTY[2]
        if (matches((y) => dark[y][i], at, pattern)) score += PENALTY[2]
      }
    }
  }
  let dark_modules = 0
  for (const row of dark) for (const module of row) if (module) dark_modules++
  const share = (dark_modules * 100) / (size * size)
  score += Math.floor(Math.abs(share - 50) / 5) * PENALTY[3]
  return score
}

/**
 * The symbol for `text`: the smallest version that holds it, and the mask the standard's penalty likes best
 * (the lower numbered one where two score the same, as the standard says). `forceMask` picks one instead:
 * for a test that holds the mask still while it checks the payload, not for the app.
 */
export function encodeQr(text: string, forceMask?: number): QrSymbol {
  const version = versionFor(new TextEncoder().encode(text).length)
  const base = patterns(version)
  const words = codewords(text, version)
  placeData(base, words)
  drawVersion(base, version)
  let best: QrSymbol | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue
    const dark = base.dark.map((row) => [...row])
    const grid: Grid = { dark, fixed: base.fixed }
    for (let y = 0; y < dark.length; y++) {
      for (let x = 0; x < dark.length; x++) {
        if (!base.fixed[y][x] && masked(mask, x, y)) dark[y][x] = !dark[y][x]
      }
    }
    drawFormat(grid, mask)
    const score = penalty(dark)
    if (score >= bestScore) continue
    bestScore = score
    best = { version, mask, size: dark.length, modules: dark }
  }
  // A version the loop's masks always cover: the first one is the fallback a compiler can see.
  return best ?? { version, mask: 0, size: base.dark.length, modules: base.dark }
}

/**
 * The symbol's modules as one path of dark squares, in a `viewBox` with `quiet` modules of blank round it:
 * what a scanner needs to find the code's edges (four modules, the standard's own quiet zone).
 */
export function qrPath(symbol: QrSymbol, quiet = 4): string {
  const parts: string[] = []
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      if (symbol.modules[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
    }
  }
  return parts.join('')
}

/** How wide a symbol's `viewBox` is, its quiet zone included. */
export function qrExtent(symbol: QrSymbol, quiet = 4): number {
  return symbol.size + quiet * 2
}
