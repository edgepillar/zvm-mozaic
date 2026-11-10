// Pictures from outside: a file, a drop, or the clipboard.
//
// An image becomes either a stamp, which follows the pointer until a click
// drops its pixels into the draft, or a guide, a see-through layer pinned over
// the canvas to trace by hand, the way r/place's communities worked from
// templates. Neither touches the chain; both are free until the draft is sent.

import {reactive, shallowRef} from 'vue'

export interface Picture {
  name: string
  /** The image at its placed size, one canvas pixel per pixel. */
  canvas: HTMLCanvasElement
  w: number
  h: number
}

/** The stamp in hand, when there is one. */
export const stamp = shallowRef<Picture | null>(null)

/** The guide pinned over the canvas. */
export const guide = reactive({
  picture: null as Picture | null,
  x: 0,
  y: 0,
  opacity: 0.45,
  visible: true,
})

/** An image ready to draw at any size. An SVG stays a vector until it is drawn. */
export interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  vector: boolean
}

/**
 * Extensions the browser can show, for files the OS hands over with no type.
 * Windows often gives an .ico, and sometimes a .webp or .avif, as "".
 */
const IMAGE_EXT = /\.(png|apng|jpe?g|jfif|pjpeg|pjp|gif|webp|avif|bmp|ico|cur|svg)$/i

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_BITMAP_PIXELS = 16_000_000

function checkBitmapSize(width: number, height: number) {
  if (width * height > MAX_BITMAP_PIXELS) throw new Error('Choose a raster image with 16 million pixels or fewer.')
}

/** Whether a file looks like an image the browser can read, by type or by name. */
export function isImage(f: {type: string; name?: string}): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name ?? '')
}


const decodedResources = new WeakMap<Decoded, () => void>()

/** Release the native source after its last preview has been rasterised. */
export function disposeDecoded(image: Decoded | null) {
  if (!image) return
  const release = decodedResources.get(image)
  decodedResources.delete(image)
  release?.()
}

const cancelledImage = () => new DOMException('Image reading was cancelled.', 'AbortError')

async function imageRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  let cancel!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(cancelledImage())
    signal.addEventListener('abort', cancel, {once: true})
  })
  try {
    if (signal.aborted) cancel()
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

// A signature, first chunk and valid IHDR checksum are enough to read PNG's
// canvas dimensions. GIF stores its logical screen immediately after the version.
const RASTER_PREFIX_BYTES = 33
const PNG_DEPTHS: Record<number, number[]> = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]}

const JPEG_PREFIX_BYTES = 64 * 1024
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb])

// undefined means the bounded prefix ended before a decision was possible.
function jpegDimensions(header: DataView): [number, number] | null | undefined {
  let offset = 2
  while (offset < header.byteLength) {
    if (header.getUint8(offset++) !== 0xff) return null
    while (offset < header.byteLength && header.getUint8(offset) === 0xff) offset++
    if (offset >= header.byteLength) return undefined
    const marker = header.getUint8(offset++)
    if (marker === 0x01) continue // TEM has no length field.
    // Stop before entropy-coded data or a hierarchical frame sequence.
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xda) || marker === 0xde) return null
    if (offset + 2 > header.byteLength) return undefined
    const length = header.getUint16(offset)
    if (length < 2) return null
    if (length > header.byteLength - offset) return undefined
    if (JPEG_FRAMES.has(marker)) {
      if (length < 11 || length !== 8 + 3 * header.getUint8(offset + 7)) return null
      const precision = header.getUint8(offset + 2)
      const lossless = marker === 0xc3 || marker === 0xcb
      const validPrecision = lossless ? precision >= 2 && precision <= 16
        : precision === 8 || (marker !== 0xc0 && precision === 12)
      const height = header.getUint16(offset + 3), width = header.getUint16(offset + 5)
      return validPrecision && width > 0 && height > 0 ? [width, height] : null
    }
    offset += length
  }
  return undefined
}

function webpDimensions(header: DataView, fileSize: number): [number, number] | null {
  if (header.byteLength < 25) return null
  const riffEnd = header.getUint32(4, true) + 8
  const chunkSize = header.getUint32(16, true)
  if (riffEnd > fileSize || riffEnd % 2 !== 0 || 20 + chunkSize + chunkSize % 2 > riffEnd) return null
  const chunk = header.getUint32(12)
  if (chunk === 0x5650384c && chunkSize >= 5 && header.getUint8(20) === 0x2f) { // VP8L
    const fields = header.getUint32(21, true)
    return (fields >>> 29) === 0 ? [(fields & 0x3fff) + 1, ((fields >>> 14) & 0x3fff) + 1] : null
  }
  if (header.byteLength < 30) return null
  if (chunk === 0x56503858 && chunkSize === 10) { // VP8X
    if ((header.getUint8(20) & 0xc1) !== 0 || (header.getUint32(20, true) >>> 8) !== 0) return null
    const width = 1 + header.getUint16(24, true) + header.getUint8(26) * 65536
    const height = 1 + header.getUint16(27, true) + header.getUint8(29) * 65536
    return width * height <= 0xffffffff ? [width, height] : null
  }
  if (chunk === 0x56503820 && chunkSize >= 10 && header.getUint8(23) === 0x9d && header.getUint16(24) === 0x012a) { // VP8
    const tag = header.getUint16(20, true) + header.getUint8(22) * 65536
    const partition = tag >>> 5
    if ((tag & 1) !== 0 || ((tag >>> 1) & 7) > 3 || partition === 0 || partition > chunkSize - 10) return null
    const width = header.getUint16(26, true) & 0x3fff, height = header.getUint16(28, true) & 0x3fff
    return width > 0 && height > 0 ? [width, height] : null
  }
  return null
}

function encodedRasterDimensions(bytes: ArrayBuffer, fileSize: number): [number, number] | null {
  const header = new DataView(bytes)
  if (header.byteLength === RASTER_PREFIX_BYTES && header.getUint32(0) === 0x89504e47
      && header.getUint32(4) === 0x0d0a1a0a && header.getUint32(8) === 13 && header.getUint32(12) === 0x49484452) {
    const width = header.getUint32(16), height = header.getUint32(20)
    if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff
        || !PNG_DEPTHS[header.getUint8(25)]?.includes(header.getUint8(24))
        || header.getUint8(26) !== 0 || header.getUint8(27) !== 0 || header.getUint8(28) > 1) return null
    let crc = 0xffffffff
    for (let offset = 12; offset < 29; offset++) {
      crc ^= header.getUint8(offset)
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    return ((crc ^ 0xffffffff) >>> 0) === header.getUint32(29) ? [width, height] : null
  }
  if (header.byteLength >= 12 && header.getUint32(0) === 0x52494646 && header.getUint32(8) === 0x57454250) {
    return webpDimensions(header, fileSize)
  }
  if (header.byteLength < 13 || header.getUint32(0) !== 0x47494638) return null
  const version = header.getUint16(4)
  if (version !== 0x3761 && version !== 0x3961) return null
  const width = header.getUint16(6, true), height = header.getUint16(8, true)
  return width > 0 && height > 0 ? [width, height] : null
}

async function readRasterHeader(file: Blob, signal?: AbortSignal) {
  let prefix: ArrayBuffer
  try {
    prefix = await imageRead(file.slice(0, RASTER_PREFIX_BYTES).arrayBuffer(), signal)
    const initial = new DataView(prefix)
    if (initial.byteLength >= 2 && initial.getUint16(0) === 0xffd8) {
      const dimensions = jpegDimensions(initial)
      if (dimensions !== undefined || file.size <= prefix.byteLength) return dimensions ?? null
      if (signal?.aborted) throw cancelledImage()
      const remainder = await imageRead(file.slice(prefix.byteLength, JPEG_PREFIX_BYTES).arrayBuffer(), signal)
      const jpeg = new Uint8Array(prefix.byteLength + remainder.byteLength)
      jpeg.set(new Uint8Array(prefix))
      jpeg.set(new Uint8Array(remainder), prefix.byteLength)
      return jpegDimensions(new DataView(jpeg.buffer)) ?? null
    }
  } catch {
    if (signal?.aborted) throw cancelledImage()
    return null
  }
  return encodedRasterDimensions(prefix, file.size)
}

/**
 * Decodes any image the browser can show: PNG, JPEG, GIF and WebP (their first
 * frame when animated), AVIF, BMP, favicons (.ico, .cur) and SVG.
 *
 * Through an <img>, not createImageBitmap: that reads most bitmaps but refuses
 * SVG outright, and is uneven on .ico. An <img> decodes whatever the page could
 * show, which is the promise worth making here.
 *
 * An SVG with no width and height of its own has no natural size in some
 * browsers, so its size is read from its viewBox. It is kept as a vector and
 * drawn at the width chosen, so it comes out sharp rather than enlarged.
 */
export async function decode(file: File | Blob, signal?: AbortSignal): Promise<Decoded> {
  const check = () => {if (signal?.aborted) throw cancelledImage()}
  check()
  const name = (file as File).name ?? ''
  if (!isImage({type: file.type, name})) throw new Error('That is not an image.')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Choose an image of 32 MiB or less.')
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(name)
  if (!svg) {
    const dimensions = await readRasterHeader(file, signal)
    check()
    if (dimensions) checkBitmapSize(...dimensions)
  }
  const blob = svg && file.type !== 'image/svg+xml'
    ? new Blob([await imageRead(file.text(), signal)], {type: 'image/svg+xml'}) : file
  check()
  const url = URL.createObjectURL(blob)
  let img: HTMLImageElement | null = null
  let bitmap: ImageBitmap | null = null
  let ownsURL = true
  let released = false
  let retained = false
  const releaseURL = () => {
    if (!ownsURL) return
    ownsURL = false
    URL.revokeObjectURL(url)
    if (img) img.src = ''
  }
  const release = () => {
    if (released) return
    released = true
    releaseURL()
    bitmap?.close()
    bitmap = null
  }
  const keep = (source: CanvasImageSource, width: number, height: number): Decoded => {
    const image = {source, width, height, vector: svg}
    decodedResources.set(image, release)
    retained = true
    return image
  }
  try {
    img = new Image()
    img.decoding = 'async'
    img.src = url
    try {
      await imageRead(img.decode(), signal)
    } catch {
      check()
      throw new Error('This browser could not read that image. PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG all work.')
    }
    check()
    let width = img.naturalWidth
    let height = img.naturalHeight
    if (svg) {
      if (!width || !height) {
        const size = svgSize(await imageRead(blob.text(), signal))
        width = size?.[0] ?? 512
        height = size?.[1] ?? 512
      }
      const k = Math.max(1, 256 / Math.max(width, height))
      width = Math.round(width * k)
      height = Math.round(height * k)
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('That image has no size to read.')
    check()
    if (svg) return keep(img, width, height)
    checkBitmapSize(width, height)
    // A bitmap allocation can finish after its caller has already cancelled.
    const pending = createImageBitmap(img).then(value => {
      if (released || signal?.aborted) {value.close(); throw cancelledImage()}
      return value
    })
    bitmap = await imageRead(pending, signal)
    check()
    checkBitmapSize(bitmap.width, bitmap.height)
    releaseURL()
    return keep(bitmap, width, height)
  } finally {
    if (!retained) release()
  }
}

/** An SVG's width and height from its attributes, else from its viewBox. */
function svgSize(text: string): [number, number] | null {
  const root = text.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const num = (attr: string) => {
    const m = root.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i'))
    return m ? Number(m[1]) : NaN
  }
  const w = num('width')
  const h = num('height')
  if (w > 0 && h > 0) return [w, h]
  const vb = root.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (vb) return [Number(vb[1]), Number(vb[2])]
  return null
}

// A stamp or guide fits within the shared board before allocating its raster.
const PICTURE_EDGE = 1000

export function pictureWidthLimit(image: Decoded): number {
  const widthAtMaxHeight = Math.round(PICTURE_EDGE * (image.width / image.height))
  return Math.min(PICTURE_EDGE, Math.max(1, widthAtMaxHeight))
}

/**
 * Scales an image toward `width` canvas pixels, fitting the board. Smoothing is
 * off when enlarging, so pixel art stays crisp, and on when shrinking, so a
 * photo averages rather than aliases.
 */
export function scaled(image: Decoded, width: number, name: string): Picture {
  const w = Math.min(pictureWidthLimit(image), Math.max(1, Math.round(width)))
  const h = Math.min(PICTURE_EDGE, Math.max(1, Math.round((image.height * w) / image.width)))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', {willReadFrequently: true})!
  // A vector is rasterised fresh at this size, so smoothing is its own
  // antialiasing; a bitmap is smoothed only when it is being shrunk.
  ctx.imageSmoothingEnabled = image.vector || w < image.width
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image.source, 0, 0, w, h)
  return {name, canvas, w, h}
}

/** Count the same pixels as pixelsOf without creating preview-only point records. */
export function pixelCount(p: Picture, alpha = 128): number {
  const d = p.canvas.getContext('2d', {willReadFrequently: true})!.getImageData(0, 0, p.w, p.h).data
  let count = 0
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const o = (y * p.w + x) * 4
      if (d[o + 3] < alpha) continue
      count++
    }
  return count
}

/**
 * Read pixels with at least `alpha` opacity, optionally within an integer
 * rectangle in picture coordinates. Returned points use picture coordinates.
 */
export function pixelsOf(p: Picture, alpha = 128, bounds?: {x: number; y: number; w: number; h: number}): {x: number; y: number; rgb: number}[] {
  const left = bounds ? Math.max(0, bounds.x) : 0
  const top = bounds ? Math.max(0, bounds.y) : 0
  const w = bounds ? Math.min(p.w, bounds.x + bounds.w) - left : p.w
  const h = bounds ? Math.min(p.h, bounds.y + bounds.h) - top : p.h
  if (bounds && (w <= 0 || h <= 0)) return []
  const d = p.canvas.getContext('2d', {willReadFrequently: true})!.getImageData(left, top, w, h).data
  const out: {x: number; y: number; rgb: number}[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (d[o + 3] < alpha) continue
      out.push({x: left + x, y: top + y, rgb: (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]})
    }
  return out
}

/** An image on the clipboard, when a paste carries one. */
export function imageFromPaste(e: ClipboardEvent): File | null {
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind !== 'file') continue
    const f = item.getAsFile()
    if (f && isImage(f)) return f
  }
  return null
}
