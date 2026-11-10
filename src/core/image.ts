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
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(name)
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
    // A bitmap allocation can finish after its caller has already cancelled.
    const pending = createImageBitmap(img).then(value => {
      if (released || signal?.aborted) {value.close(); throw cancelledImage()}
      return value
    })
    bitmap = await imageRead(pending, signal)
    check()
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
