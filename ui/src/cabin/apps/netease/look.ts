import type { Song } from './netease'

/**
 * What the NetEase app's pages show alike: a cover, the colour it's washed in, what a thing is, and whether it's
 * what plays.
 *
 * The service gives a picture and nothing of its colours, so the app picks one from the item's name and id: the
 * same playlist is the same colour every time it's drawn, with no pixel read (which a cross-origin picture
 * wouldn't allow anyway).
 */

/** What a cover shows: the picture, the name it falls back to, and whether it's round (an artist's). */
export interface Covered {
  name: string
  picture: string
  round?: boolean
}

/** The colour a name is washed in: a hue from its letters and id, dark enough for white words over it. */
export function tintOf(name: string, id = 0): string {
  let hash = id % 360
  for (const letter of name) hash = (hash * 31 + letter.codePointAt(0)!) % 360
  const saturation = 34 + (hash % 3) * 8
  return `hsl(${hash % 360} ${saturation}% 30%)`
}

/** The hue a name falls back to, before its cover has told the page a colour of its own (`tintOf`'s own). */
export function hueOf(name: string, id = 0): number {
  let hash = id % 360
  for (const letter of name) hash = (hash * 31 + letter.codePointAt(0)!) % 360
  return hash % 360
}

/**
 * A cover's own colours, read off the picture: its dominant hue and how strong it is.
 *
 * The service's covers are another origin, so a page can't read their pixels with a 2D canvas (`getImageData`
 * throws on a tainted one). This draws the picture into a tiny WebGL canvas and reads the 1×1 result back:
 * WebGL's `readPixels` isn't tainted by a cross-origin `img`, so the colour comes out. `null` where the page
 * has no WebGL, or the picture won't load (the app then keeps the name's own colour).
 */
export function coverColour(url: string): Promise<{ hue: number; saturation: number } | null> {
  if (!url || typeof document === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const image = new Image()
    // The covers are cross-origin: without this the canvas would be tainted even for WebGL.
    image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    let settled = false
    const done = (value: { hue: number; saturation: number } | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // A picture that never loads mustn't hold the colour for ever.
    const timer = setTimeout(() => done(null), 4000)
    image.onerror = () => {
      clearTimeout(timer)
      done(null)
    }
    image.onload = () => {
      clearTimeout(timer)
      try {
        done(readColour(image))
      } catch {
        done(null)
      }
    }
    image.src = url
  })
}

/** The colour of a loaded picture, as its dominant hue and saturation (WebGL's own 1×1 read). */
function readColour(image: HTMLImageElement): { hue: number; saturation: number } | null {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
  if (!gl) return null
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  // The whole picture squeezed to one pixel: its average colour, which is the wash a player expects.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const pixel = new Uint8Array(4)
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  const [r, g, b] = pixel
  return rgbToHsl(r / 255, g / 255, b / 255)
}

/** `r`, `g`, `b` (0 to 1) as a hue in degrees and a saturation (0 to 1). */
function rgbToHsl(r: number, g: number, b: number): { hue: number; saturation: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  const delta = max - min
  if (delta < 0.0001) return { hue: 0, saturation: 0 }
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6
  else if (max === g) hue = ((b - r) / delta + 2) / 6
  else hue = ((r - g) / delta + 4) / 6
  return { hue: hue * 360, saturation }
}

/**
 * The wash a cover gives Now Playing: its own hue, kept dark enough for white words over it, and deep enough
 * to read as a colour (a grey or black cover keeps a little of its own, never none). `fallback` is the name's
 * own hue, for a cover the page can't read.
 */
export function washFrom(colour: { hue: number; saturation: number } | null, fallback: number): string {
  if (!colour) return `hsl(${fallback} 38% 30%)`
  // A cover's colour is often washed out by its own grain: a floor keeps the page from going grey.
  const saturation = Math.min(62, Math.max(26, colour.saturation * 100 * 0.9))
  return `hsl(${Math.round(colour.hue)} ${Math.round(saturation)}% 32%)`
}

/** A song's cover: its album's picture. */
export function songCover(song: Song): Covered {
  return { name: song.album || song.name, picture: song.picture }
}

/** The name an item's cover falls back to, and its colour. */
export function coverStyle(name: string, id: number): string {
  return tintOf(name, id)
}
