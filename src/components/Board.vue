<script setup lang="ts">
// The canvas: a view onto the million pixels, and every tool's hands.
//
// Drawn on one <canvas> sized to the element, from three one-pixel-per-pixel
// layers the stores keep (the chain's pixels, the pending ones, the draft), so
// a frame is a handful of scaled drawImage calls whatever the zoom. It draws on
// demand, and runs a frame loop only while something is moving: pending
// pixels breathing, a fresh paint's pink ring fading, the view gliding to a
// located paint.
//
// Nothing here is reactive per frame. The view (scale and offset) is plain
// numbers; the status line under the canvas is the one reactive object, and
// it is written at most once a frame.
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import {board, colorAt, onArrived, onAttributionChanged, onChanged, paints, surface, whoPainted, W, H, type Paint} from '../core/board'
import {beginStroke, draftSurface, endStroke, onLayers, pending, pendingSurface, put, remove, seen, draftState} from '../core/draft'
import {axis, prefs, putDown, used} from '../core/prefs'
import {blend, toHex} from '../core/color'
import {brushLine, ellipse, flood, gradientColor, mirrored, rect, snap45, spray, square, stamp as footprint, type Pt} from '../core/tools'
import {guide, isImage, pixelsOf, stamp} from '../core/image'
import {chain} from '../core/chain'
import {same} from '../core/format'
import {endpoint, explorerUrl} from '../core/endpoint'
import {wallet} from '../core/wallet'
import Avatar from './Avatar.vue'
import Who from './Who.vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{bare?: boolean}>(), {bare: false})
const emit = defineEmits<{(e: 'drop-image', file: File): void}>()

const host = ref<HTMLDivElement | null>(null)
const cv = ref<HTMLCanvasElement | null>(null)
const mini = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let disposed = false
let viewEpoch = 0

// --- the view -------------------------------------------------------------------

let cssW = 0
let cssH = 0
let dpr = 1
/** Screen pixels per canvas pixel, and where canvas pixel 0,0 sits on screen. */
let scale = 1
let ox = 0
let oy = 0
const MAX_SCALE = 64

/**
 * How far out the view may go, the owner's calls (2026-09-29). On the canvas
 * page the canvas always covers the board: never zoomed out past the scale at
 * which it fills both directions, so there is no dark space around it, and
 * the rest of the longer side is reached by panning. Only the gallery may zoom
 * out until the whole canvas is in view, with the space left over on the
 * shorter side split evenly around it.
 */
const coverScale = () => Math.max(cssW / Math.max(1, W), cssH / Math.max(1, H))
const containScale = () => Math.min(cssW / Math.max(1, W), cssH / Math.max(1, H))
const minScale = () => (props.bare ? containScale() : coverScale())

/**
 * An offset may not uncover an edge. Where the canvas is narrower than the
 * board, which only the gallery allows, it is held in the middle instead.
 */
function clampAxis(offset: number, board: number, size: number) {
  return size <= board ? (board - size) / 2 : Math.min(0, Math.max(board - size, offset))
}
function clampView() {
  ox = clampAxis(ox, cssW, W * scale)
  oy = clampAxis(oy, cssH, H * scale)
}
const toCanvas = (sx: number, sy: number): Pt => ({x: Math.floor((sx - ox) / scale), y: Math.floor((sy - oy) / scale)})

export interface Hud {
  x: number | null
  y: number | null
  color: number | null
  draft: number | null
  painter: string | null
  paintedAgo: string | null
  zoom: number
}
const hud = reactive<Hud>({x: null, y: null, color: null, draft: null, painter: null, paintedAgo: null, zoom: 1})

function setView(s: number, x: number, y: number) {
  if (disposed || board.status !== 'ready' || !W || !H) return
  scale = Math.max(minScale(), Math.min(MAX_SCALE, s))
  ox = x
  oy = y
  clampView()
  hud.zoom = scale
  invalidate()
  drawMiniSoon()
  rememberView()
}

/** Zooms by a factor, keeping the canvas point under (sx, sy) where it is. */
function zoomAt(factor: number, sx = cssW / 2, sy = cssH / 2) {
  const next = Math.max(minScale(), Math.min(MAX_SCALE, scale * factor))
  const k = next / scale
  setView(next, sx - (sx - ox) * k, sy - (sy - oy) * k)
}

function centerOn(x: number, y: number, s = scale) {
  setView(s, cssW / 2 - (x + 0.5) * s, cssH / 2 - (y + 0.5) * s)
}

/** As far out as the view goes: the whole canvas in the gallery, covering the board elsewhere. */
function fit() {
  glide = null
  const s = minScale()
  setView(s, (cssW - W * s) / 2, (cssH - H * s) / 2)
}

// The view rides in the address bar, so a link opens on the same pixels.
let urlTimer: number | undefined
function rememberView() {
  clearTimeout(urlTimer)
  const epoch = viewEpoch
  const path = location.pathname
  urlTimer = window.setTimeout(() => {
    if (disposed || epoch !== viewEpoch || location.pathname !== path) return
    urlTimer = undefined
    const u = new URL(location.href)
    const c = toCanvas(cssW / 2, cssH / 2)
    u.searchParams.set('x', String(Math.max(0, Math.min(W - 1, c.x))))
    u.searchParams.set('y', String(Math.max(0, Math.min(H - 1, c.y))))
    u.searchParams.set('z', String(+scale.toFixed(2)))
    history.replaceState(history.state, '', u)
  }, 400)
}

function initialView() {
  const q = new URLSearchParams(location.search)
  const x = Number(q.get('x'))
  const y = Number(q.get('y'))
  const z = Number(q.get('z'))
  if (q.has('x') && q.has('y') && Number.isFinite(x) && Number.isFinite(y)) centerOn(x, y, Number.isFinite(z) && z > 0 ? z : 8)
  else cover()
}

/** Covering the board, centred: where every view starts, the gallery's included. */
function cover() {
  const s = coverScale()
  setView(s, (cssW - W * s) / 2, (cssH - H * s) / 2)
}

// --- drawing ------------------------------------------------------------------------

let frame = 0
let looping = false
const css = {bg: '#04080a', line: '#1a262a', edge: '#2b3a40', nom: '#5da4ff', fresh: '#f91690', fg: '#e6efec'}

function readCss() {
  const s = getComputedStyle(document.documentElement)
  css.bg = s.getPropertyValue('--sunk').trim() || css.bg
  css.line = s.getPropertyValue('--line').trim() || css.line
  css.edge = s.getPropertyValue('--line-strong').trim() || css.edge
  css.nom = s.getPropertyValue('--nom-ink').trim() || css.nom
  css.fg = s.getPropertyValue('--fg').trim() || css.fg
}

function invalidate() {
  if (disposed) return
  if (!frame) frame = requestAnimationFrame(render)
}

/** Recent arrivals, each ringed in pink for a few seconds. */
const fresh: {p: Paint; at: number}[] = []
const FRESH_MS = 6000
/** A located paint, outlined while the view glides to it. */
let located: {p: {x0: number; y0: number; x1: number; y1: number}; at: number} | null = null
let glide: {from: [number, number, number]; to: [number, number, number]; at: number} | null = null

/** The tool's preview: points, and the colour each would take. */
let preview: {pts: Pt[]; color: (p: Pt) => number} | null = null
const previewCanvas = document.createElement('canvas')
let hover: Pt | null = null

function render(now: number) {
  frame = 0
  if (disposed || !ctx) return
  looping = false

  if (glide) {
    const t = Math.min(1, (now - glide.at) / 420)
    const e = 1 - Math.pow(1 - t, 3)
    const [s0, x0, y0] = glide.from
    const [s1, x1, y1] = glide.to
    // Interpolate in log scale so a deep zoom does not rush its last half.
    const s = Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * e)
    const cx = x0 + (x1 - x0) * e
    const cy = y0 + (y1 - y0) * e
    scale = Math.max(minScale(), s)
    ox = cssW / 2 - cx * scale
    oy = cssH / 2 - cy * scale
    clampView()
    hud.zoom = scale
    if (t < 1) looping = true
    else {
      glide = null
      rememberView()
      drawMiniSoon()
    }
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = css.bg
  ctx.fillRect(0, 0, cssW, cssH)
  if (!W) return

  // Only the visible part of each layer is scaled up.
  const vx0 = Math.max(0, Math.floor(-ox / scale))
  const vy0 = Math.max(0, Math.floor(-oy / scale))
  const vx1 = Math.min(W, Math.ceil((cssW - ox) / scale))
  const vy1 = Math.min(H, Math.ceil((cssH - oy) / scale))
  const vw = vx1 - vx0
  const vh = vy1 - vy0

  // No drop shadow here: the canvas covers the board, and a shadow set while
  // the squares were drawn gave every square its own dark rim.
  checker(ctx, ox, oy, scale)
  ctx.imageSmoothingEnabled = scale < 1
  if (vw > 0 && vh > 0) {
    const blit = (src: CanvasImageSource) => ctx!.drawImage(src, vx0, vy0, vw, vh, ox + vx0 * scale, oy + vy0 * scale, vw * scale, vh * scale)
    blit(surface)
    if (guide.picture && guide.visible) {
      ctx.globalAlpha = guide.opacity
      ctx.drawImage(guide.picture.canvas, ox + guide.x * scale, oy + guide.y * scale, guide.picture.w * scale, guide.picture.h * scale)
      ctx.globalAlpha = 1
    }
    if (prefs.showDraft) {
      if (pending.size) {
        // Ordered, not yet executed: it breathes until its block lands.
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 320) ** 2
        blit(pendingSurface)
        ctx.globalAlpha = 1
        looping = true
      }
      if (draftState.size) blit(draftSurface)
    }
  }

  // The grid, once a pixel is big enough to aim at.
  if (prefs.grid && !props.bare && scale >= 10 && vw > 0) {
    ctx.strokeStyle = 'rgb(128 128 128 / 0.22)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = vx0; x <= vx1; x++) {
      const sx = Math.round(ox + x * scale) + 0.5
      ctx.moveTo(sx, oy + vy0 * scale)
      ctx.lineTo(sx, oy + vy1 * scale)
    }
    for (let y = vy0; y <= vy1; y++) {
      const sy = Math.round(oy + y * scale) + 0.5
      ctx.moveTo(ox + vx0 * scale, sy)
      ctx.lineTo(ox + vx1 * scale, sy)
    }
    ctx.stroke()
  }

  if (preview) drawPoints(preview.pts, preview.color)

  if (stamp.value && hover) {
    ctx.globalAlpha = 0.85
    ctx.drawImage(stamp.value.canvas, ox + hover.x * scale, oy + hover.y * scale, stamp.value.w * scale, stamp.value.h * scale)
    ctx.globalAlpha = 1
    ring(hover.x, hover.y, hover.x + stamp.value.w - 1, hover.y + stamp.value.h - 1, css.nom, 1.5)
  }

  // Pink: painted by someone in the last few seconds.
  if (prefs.fresh) {
    for (let k = fresh.length - 1; k >= 0; k--) {
      const age = now - fresh[k].at
      if (age > FRESH_MS) {
        fresh.splice(k, 1)
        continue
      }
      const {p} = fresh[k]
      ctx.globalAlpha = 1 - age / FRESH_MS
      ring(p.x0, p.y0, p.x1, p.y1, css.fresh, 2, 4 + (age / FRESH_MS) * 6)
      looping = true
    }
    ctx.globalAlpha = 1
  }

  // The selected pixel: a ring at least a finger's width across, so it can be
  // found at any zoom, and a tight outline once pixels are big enough to see.
  if (picked.value) {
    const {x, y} = picked.value
    const cx = ox + (x + 0.5) * scale
    const cy = oy + (y + 0.5) * scale
    const r = Math.max(10, scale * 0.9)
    ctx.lineWidth = 2
    ctx.strokeStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = css.nom
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    if (scale >= 6) ring(x, y, x, y, css.nom, 2)
  }

  if (located) {
    const age = now - located.at
    if (age < 2600) {
      const on = Math.floor(age / 260) % 2 === 0
      if (on) ring(located.p.x0, located.p.y0, located.p.x1, located.p.y1, css.nom, 2, 5)
      looping = true
    } else located = null
  }

  // Mirror axes.
  ctx.setLineDash([6, 5])
  ctx.strokeStyle = css.nom
  ctx.lineWidth = 1
  if (prefs.mirrorX) {
    const sx = Math.round(ox + (axis.x + 0.5) * scale) + 0.5
    ctx.beginPath()
    ctx.moveTo(sx, oy)
    ctx.lineTo(sx, oy + H * scale)
    ctx.stroke()
  }
  if (prefs.mirrorY) {
    const sy = Math.round(oy + (axis.y + 0.5) * scale) + 0.5
    ctx.beginPath()
    ctx.moveTo(ox, sy)
    ctx.lineTo(ox + W * scale, sy)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // The brush's footprint under the pointer.
  if (props.bare) {
    /* only the canvas */
  } else if (hover && !stamp.value && !panning && ['brush', 'eraser', 'spray', 'line'].includes(prefs.tool)) {
    const n = prefs.tool === 'spray' ? Math.max(2, prefs.size * 1.5) * 2 + 1 : prefs.size
    const lo = Math.floor((n - 1) / 2)
    ring(hover.x - lo, hover.y - lo, hover.x - lo + Math.ceil(n) - 1, hover.y - lo + Math.ceil(n) - 1, css.fg, 1)
  } else if (hover && !panning && !stamp.value && scale >= 4) {
    ring(hover.x, hover.y, hover.x, hover.y, css.fg, 1)
  }

  ctx.strokeStyle = css.edge
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(ox) - 0.5, Math.round(oy) - 0.5, Math.round(W * scale) + 1, Math.round(H * scale) + 1)

  if (looping) frame = requestAnimationFrame(render)
}

/**
 * What shows through where the canvas is blank: one dark space grey, ruled by
 * thin light-grey lines every 50 canvas pixels, a 20 x 20 grid over the whole
 * canvas (the owner's call, 2026-09-29). The lines are a screen pixel wide at
 * any zoom and sit on the pixel grid, so they stay sharp. Only the lines on
 * screen are drawn.
 */
const GRID = 50
const BLANK = '#2b2e33'
const RULE = 'rgb(200 205 212 / 0.32)'
function checker(c: CanvasRenderingContext2D, x: number, y: number, s: number, w = cssW, h = cssH) {
  c.fillStyle = BLANK
  c.fillRect(x, y, W * s, H * s)
  const step = GRID * s
  // Too dense to read as a grid: a canvas this far out is all rule.
  if (step < 4) return
  const x0 = Math.max(x, 0)
  const y0 = Math.max(y, 0)
  const x1 = Math.min(x + W * s, w)
  const y1 = Math.min(y + H * s, h)
  c.beginPath()
  for (let i = Math.max(1, Math.ceil((x0 - x) / step)); i < W / GRID; i++) {
    const sx = Math.round(x + i * step) + 0.5
    if (sx > x1) break
    c.moveTo(sx, y0)
    c.lineTo(sx, y1)
  }
  for (let j = Math.max(1, Math.ceil((y0 - y) / step)); j < H / GRID; j++) {
    const sy = Math.round(y + j * step) + 0.5
    if (sy > y1) break
    c.moveTo(x0, sy)
    c.lineTo(x1, sy)
  }
  c.strokeStyle = RULE
  c.lineWidth = 1
  c.stroke()
}

/** An outline around canvas pixels x0..x1, y0..y1, `pad` screen pixels out. */
function ring(x0: number, y0: number, x1: number, y1: number, color: string, width: number, pad = 0) {
  const a = ox + x0 * scale - pad
  const b = oy + y0 * scale - pad
  const w = Math.max(1, (x1 - x0 + 1) * scale) + pad * 2
  const h = Math.max(1, (y1 - y0 + 1) * scale) + pad * 2
  ctx!.strokeStyle = color
  ctx!.lineWidth = width
  ctx!.strokeRect(Math.round(a) + 0.5, Math.round(b) + 0.5, Math.round(w), Math.round(h))
}

/** A tool preview: the points painted into a small canvas the size of their box, then scaled. */
function drawPoints(pts: Pt[], color: (p: Pt) => number) {
  if (!pts.length || !ctx) return
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  if (w * h > 4_000_000) return
  previewCanvas.width = w
  previewCanvas.height = h
  const pc = previewCanvas.getContext('2d')!
  const img = pc.createImageData(w, h)
  for (const p of pts) {
    const c = color(p)
    const o = ((p.y - y0) * w + (p.x - x0)) * 4
    img.data[o] = c >> 16
    img.data[o + 1] = (c >> 8) & 0xff
    img.data[o + 2] = c & 0xff
    img.data[o + 3] = 255
  }
  pc.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(previewCanvas, ox + x0 * scale, oy + y0 * scale, w * scale, h * scale)
}

// --- the minimap --------------------------------------------------------------------

let miniTimer: number | undefined
let miniDirty = false
function drawMiniSoon() {
  if (disposed) return
  miniDirty = true
  if (miniTimer) return
  const epoch = viewEpoch
  miniTimer = window.setTimeout(() => {
    if (disposed || epoch !== viewEpoch) return
    miniTimer = undefined
    if (miniDirty) drawMini()
  }, 120)
}

function drawMini() {
  miniDirty = false
  const m = mini.value
  if (!m || !W) return
  const size = 150
  const r = window.devicePixelRatio || 1
  m.width = size * r
  m.height = size * r
  const c = m.getContext('2d')!
  c.setTransform(r, 0, 0, r, 0, 0)
  const k = size / Math.max(W, H)
  checker(c, 0, 0, k, size, size)
  c.imageSmoothingEnabled = true
  c.drawImage(surface, 0, 0, W * k, H * k)
  c.strokeStyle = css.nom
  c.lineWidth = 1.5
  const a = toCanvas(0, 0)
  const b = toCanvas(cssW, cssH)
  c.strokeRect(Math.max(0, a.x * k), Math.max(0, a.y * k), Math.min(size, (b.x - a.x) * k), Math.min(size, (b.y - a.y) * k))
}

function miniJump(e: PointerEvent) {
  if (disposed) return
  glide = null
  if (e.type === 'pointermove' && !(e.buttons & 1)) return
  const m = mini.value!
  const r = m.getBoundingClientRect()
  const k = Math.max(W, H) / r.width
  centerOn((e.clientX - r.left) * k, (e.clientY - r.top) * k)
}

// --- tools ---------------------------------------------------------------------------

type Mode = null | 'pan' | 'brush' | 'erase' | 'spray' | 'shape' | 'gradient' | 'pinch'
let mode: Mode = null
let panning = false
let space = false
let start: Pt | null = null
let last: Pt | null = null
/** Where the last brush stroke ended, for shift-click straight lines. */
let strokeEnd: Pt | null = null
let strokeColor = 0
let touched = new Set<number>()
let sprayTimer: number | undefined
let region: Pt[] = []
const pointers = new Map<number, {x: number; y: number}>()
let pinch: {d: number; cx: number; cy: number} | null = null
let gestureEpoch = 0
const ownsGesture = (epoch: number) => !disposed && epoch === gestureEpoch && board.status === 'ready'

/** End applied freehand work; discard uncommitted shape previews. */
function stopGesture(finishStroke = true, releasePointers = true) {
  gestureEpoch++
  clearInterval(sprayTimer)
  sprayTimer = undefined
  cancelAnimationFrame(previewFrame)
  previewFrame = 0
  previewAt = null
  if (finishStroke && (mode === 'brush' || mode === 'erase' || mode === 'spray')) endStroke()
  mode = null
  panning = false
  tap = null
  preview = null
  region = []
  start = last = null
  pinch = null
  if (releasePointers) {
    const ids = [...pointers.keys()]
    pointers.clear()
    for (const id of ids) {
      try {
        const canvas = cv.value
        if (canvas?.hasPointerCapture(id)) canvas.releasePointerCapture(id)
      } catch {
        // The browser may already have retired an ended pointer.
      }
    }
  }
}

/** Transient input and old paint marks never belong to the next canvas. */
function resetViewContext() {
  viewEpoch++
  stopGesture()
  strokeEnd = null
  fresh.length = 0
  located = null
  glide = null
  clearTimeout(urlTimer)
  urlTimer = undefined
  clearTimeout(miniTimer)
  miniTimer = undefined
  miniDirty = false
}

function onCancel(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  stopGesture()
  invalidate()
}

function onBlur() {
  space = false
  stopGesture()
  invalidate()
}

function onVisibility() {
  if (document.visibilityState === 'hidden') onBlur()
}

/** Keep the same centre while adopting the current canvas's zoom bounds. */
function reconcileView() {
  if (!cssW || !cssH || !W || !H || board.status !== 'ready') return
  if (!viewed) {
    viewed = true
    initialView()
    return
  }
  const cx = (cssW / 2 - ox) / scale
  const cy = (cssH / 2 - oy) / scale
  const next = Math.max(minScale(), Math.min(MAX_SCALE, scale))
  setView(next, cssW / 2 - cx * next, cssH / 2 - cy * next)
}

const inside = (p: Pt) => p.x >= 0 && p.y >= 0 && p.x < W && p.y < H
const mirrorOf = (pts: Pt[]) => mirrored(pts, prefs.mirrorX ? axis.x : null, prefs.mirrorY ? axis.y : null)

/** Lays points into the draft, each pixel once per stroke, opacity blended over what is seen there. */
function lay(pts: Pt[], color: (p: Pt) => number) {
  const epoch = gestureEpoch
  for (const p of mirrorOf(pts)) {
    if (!ownsGesture(epoch)) return
    if (!inside(p)) continue
    const i = p.y * W + p.x
    if (touched.has(i)) continue
    touched.add(i)
    const c = color(p)
    put(p.x, p.y, prefs.opacity < 1 ? blend(c, seen(i), prefs.opacity) : c)
  }
}

function erase(pts: Pt[]) {
  const epoch = gestureEpoch
  for (const p of mirrorOf(pts)) {
    if (!ownsGesture(epoch)) return
    remove(p.x, p.y)
  }
}

function pos(e: PointerEvent | WheelEvent | MouseEvent) {
  const r = cv.value!.getBoundingClientRect()
  return {sx: e.clientX - r.left, sy: e.clientY - r.top}
}

function pick(p: Pt, into: 'primary' | 'secondary' = 'primary') {
  if (!inside(p)) return
  prefs[into] = seen(p.y * W + p.x)
}

function onDown(e: PointerEvent) {
  if (disposed || board.status !== 'ready' || pointers.has(e.pointerId) || pointers.size >= 2) return
  glide = null
  cv.value!.setPointerCapture(e.pointerId)
  const {sx, sy} = pos(e)
  pointers.set(e.pointerId, {x: sx, y: sy})

  // A second finger turns whatever the first was doing into a pinch.
  if (pointers.size === 2) {
    stopGesture(true, false)
    const [a, b] = [...pointers.values()]
    pinch = {d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2}
    mode = 'pinch'
    return
  }
  gestureEpoch++

  const p = toCanvas(sx, sy)
  // Bare, the canvas is only looked at: every drag moves the view.
  // An image in hand is placed by the next click, whatever the tool. It used
  // to be asked after the move tool, so with the hand selected a stamp could
  // never be put down.
  if (e.button === 0 && stamp.value && !props.bare && !space) {
    dropStamp(p)
    return
  }
  // The right button with the hand on puts the hand down.
  if (!props.bare && e.button === 2 && prefs.tool === 'pan' && !space) {
    putDown('pan')
    return
  }
  if (props.bare || e.button === 1 || space || prefs.tool === 'pan') {
    mode = 'pan'
    panning = true
    last = {x: sx, y: sy}
    // A press that lifts where it went down, with the hand, is a tap: it
    // selects the pixel. A drag moves the view, as before.
    tap = !props.bare && e.button === 0 && !space ? {x: sx, y: sy} : null
    return
  }
  if (e.altKey || prefs.tool === 'picker') {
    pick(p, e.button === 2 ? 'secondary' : 'primary')
    return
  }
  if (e.button !== 0 && e.button !== 2) return
  // The right button paints with the second colour.
  strokeColor = e.button === 2 ? prefs.secondary : prefs.primary
  touched = new Set()
  start = p
  last = p

  switch (prefs.tool) {
    case 'brush':
      mode = 'brush'
      beginStroke()
      lay(e.shiftKey && strokeEnd ? brushLine(strokeEnd, p, prefs.size, prefs.round) : footprint(p, prefs.size, prefs.round), () => strokeColor)
      break
    case 'eraser':
      mode = 'erase'
      beginStroke()
      erase(footprint(p, prefs.size, prefs.round))
      break
    case 'spray': {
      mode = 'spray'
      beginStroke()
      lay(spray(p, prefs.size, prefs.density), () => strokeColor)
      // A held spray belongs to this press, even after A -> B -> A.
      const epoch = gestureEpoch
      sprayTimer = window.setInterval(() => {
        if (!ownsGesture(epoch) || mode !== 'spray') return
        touched = new Set()
        if (last) lay(spray(last, prefs.size, prefs.density), () => strokeColor)
      }, 60)
      break
    }
    case 'fill': {
      if (!inside(p)) return
      const {pts} = flood(p, W, H, seen, prefs.tolerance, W * H)
      beginStroke()
      lay(pts, () => strokeColor)
      endStroke()
      used(strokeColor)
      break
    }
    case 'gradient': {
      if (!inside(p)) return
      mode = 'gradient'
      region = flood(p, W, H, seen, prefs.tolerance, W * H).pts
      break
    }
    default:
      mode = 'shape'
  }
  updatePreview(p, e.shiftKey)
  invalidate()
}

function updatePreview(p: Pt, shift: boolean) {
  if (!start) return
  const from = prefs.tool === 'brush' ? null : start
  if (mode === 'shape' && from) {
    const t = Math.max(1, prefs.size)
    if (prefs.tool === 'line') preview = {pts: mirrorOf(brushLine(from, shift ? snap45(from, p) : p, prefs.size, prefs.round)), color: () => strokeColor}
    if (prefs.tool === 'rect') preview = {pts: mirrorOf(rect(from, shift ? square(from, p) : p, prefs.filled, t)), color: () => strokeColor}
    if (prefs.tool === 'ellipse') preview = {pts: mirrorOf(ellipse(from, shift ? square(from, p) : p, prefs.filled, t)), color: () => strokeColor}
  } else if (mode === 'gradient' && from) {
    const a = strokeColor
    const b = strokeColor === prefs.primary ? prefs.secondary : prefs.primary
    preview = {pts: region, color: (q) => gradientColor(q, from, p, a, b)}
  }
}

// A filled rectangle across the whole canvas is a million points, so the
// preview is recomputed at most once a frame, for wherever the pointer is by then.
let previewFrame = 0
let previewAt: {p: Pt; shift: boolean} | null = null
function previewSoon(p: Pt, shift: boolean) {
  previewAt = {p, shift}
  if (previewFrame) return
  const epoch = gestureEpoch
  previewFrame = requestAnimationFrame(() => {
    if (!ownsGesture(epoch)) return
    previewFrame = 0
    if (previewAt && (mode === 'shape' || mode === 'gradient')) updatePreview(previewAt.p, previewAt.shift)
    invalidate()
  })
}

function onMove(e: PointerEvent) {
  if (disposed) return
  if (board.status !== 'ready') { stopGesture(); return }
  if (mode && !pointers.has(e.pointerId)) return
  const {sx, sy} = pos(e)
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, {x: sx, y: sy})
  const p = toCanvas(sx, sy)

  if (mode === 'pinch' && pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    ox += cx - pinch.cx
    oy += cy - pinch.cy
    zoomAt(d / Math.max(1, pinch.d), cx, cy)
    pinch = {d, cx, cy}
    return
  }
  if (mode === 'pan' && last) {
    if (tap && Math.hypot(sx - tap.x, sy - tap.y) > TAP_SLOP) tap = null
    setView(scale, ox + sx - last.x, oy + sy - last.y)
    last = {x: sx, y: sy}
    return
  }

  if (!hover || hover.x !== p.x || hover.y !== p.y) {
    hover = p
    describe(p)
    if (mode === 'brush' && last) lay(brushLine(last, p, prefs.size, prefs.round), () => strokeColor)
    if (mode === 'erase' && last) erase(brushLine(last, p, prefs.size, prefs.round))
    if (mode === 'spray') {
      touched = new Set()
      lay(spray(p, prefs.size, prefs.density), () => strokeColor)
    }
    if (mode === 'shape' || mode === 'gradient') previewSoon(p, e.shiftKey)
    if (mode) last = p
    invalidate()
  }
}

function onUp(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  if (disposed || board.status !== 'ready') { stopGesture(); return }
  if (mode === 'pinch') {
    stopGesture(false)
    invalidate()
    return
  }
  clearInterval(sprayTimer)
  cancelAnimationFrame(previewFrame)
  previewFrame = 0
  const {sx, sy} = pos(e)
  const p = toCanvas(sx, sy)
  if (mode === 'shape' || mode === 'gradient') {
    updatePreview(p, e.shiftKey)
    if (preview) {
      beginStroke()
      lay(preview.pts.filter(inside), preview.color)
      endStroke()
      used(strokeColor)
    }
  } else if (mode === 'brush' || mode === 'spray') {
    endStroke()
    used(strokeColor)
    strokeEnd = last
  } else if (mode === 'erase') endStroke()
  if (mode === 'pan' && tap) select(p)
  stopGesture(false)
  invalidate()
}

// --- a selected pixel, and who last painted it --------------------------------------

/** How far a press may wander, in screen pixels, and still be a tap. A finger wobbles. */
const TAP_SLOP = 6
let tap: {x: number; y: number} | null = null

interface Picked {
  x: number
  y: number
  color: number
  /** The draft's colour here, when it differs from the canvas's. */
  draft: number | null
  painter: string | null
  ago: string | null
  block: number | null
  tx: string | null
}
const picked = ref<Picked | null>(null)

/** Selects a pixel, or clears the selection when it is the one already selected. */
function select(p: Pt) {
  if (!inside(p) || (picked.value && picked.value.x === p.x && picked.value.y === p.y)) {
    picked.value = null
  } else {
    picked.value = readPixel(p)
  }
  invalidate()
}

function readPixel(p: Pt): Picked {
  const i = p.y * W + p.x
  const who = whoPainted(i)
  // The transaction: the paint in that block, by that painter, whose box holds the pixel.
  let tx: string | null = null
  if (who) {
    for (let k = paints.value.length - 1; k >= 0; k--) {
      const q = paints.value[k]
      if (q.block === who.block && same(q.painter, who.painter) && p.x >= q.x0 && p.x <= q.x1 && p.y >= q.y0 && p.y <= q.y1) {
        tx = q.tx
        break
      }
    }
  }
  return {
    x: p.x,
    y: p.y,
    color: colorAt(i),
    draft: seen(i) !== colorAt(i) ? seen(i) : null,
    painter: who?.painter ?? null,
    ago: who && chain.head !== null ? agoBlocks(chain.head - who.block) : null,
    block: who?.block ?? null,
    tx,
  }
}

/** Refresh inspection only; history does not repaint or recount draft pixels. */
function refreshDetails() {
  if (disposed) return
  if (picked.value) picked.value = inside(picked.value) ? readPixel(picked.value) : null
  if (hover) describe(hover)
}

/**
 * No painter known. When the page has read every paint since the canvas was
 * deployed, that means nobody ever painted it; otherwise the last paint here
 * is older than the day of paints the page reads.
 */
const unknownWhy = computed(() => {
  const c = picked.value
  if (!c) return ''
  if (board.status !== 'ready') return 'Canvas details are unavailable.'
  if (c.painter) return ''
  if (board.historyLoading) return 'Reading recent activity...'
  if (board.historyFrom === null) return 'Recent activity could not be read.'
  if (board.clearedAt !== null && chain.head !== null && c.color === 0xffffff) return `Blank since the owner cleared the canvas, ${agoBlocks(chain.head - board.clearedAt)}.`
  const everything = board.historyFrom !== null && endpoint.deployBlock !== null && board.historyFrom <= endpoint.deployBlock
  return everything ? 'Never painted.' : 'Not painted in the last day. Who painted it before then is older than this page reads.'
})

function clearPick() {
  picked.value = null
  invalidate()
}

function onKeyPick(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  stopGesture()
  if (picked.value) clearPick()
  invalidate()
}

function onLeave() {
  if (mode) return
  hover = null
  hud.x = hud.y = hud.color = hud.draft = null
  hud.painter = hud.paintedAgo = null
  invalidate()
}

function onWheel(e: WheelEvent) {
  if (disposed) return
  glide = null
  e.preventDefault()
  const {sx, sy} = pos(e)
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? cssH : 1
  // A trackpad pans with two fingers and pinches with ctrl held; a mouse
  // wheel only ever zooms, because on a canvas that is what a wheel is for.
  if (!e.ctrlKey && Math.abs(e.deltaX) > 0 && e.deltaMode === 0 && Math.abs(e.deltaY) < 40 && Math.abs(e.deltaX) + Math.abs(e.deltaY) < 60 && !Number.isInteger(e.deltaY)) {
    setView(scale, ox - e.deltaX, oy - e.deltaY)
    return
  }
  zoomAt(Math.exp((-e.deltaY * unit) / (e.ctrlKey ? 120 : 500)), sx, sy)
}

function dropStamp(at: Pt) {
  const epoch = gestureEpoch
  if (!ownsGesture(epoch)) return
  const pic = stamp.value
  if (!pic) return
  beginStroke()
  touched = new Set()
  const boardInPicture = {x: -at.x, y: -at.y, w: W, h: H}
  for (const q of pixelsOf(pic, undefined, boardInPicture)) {
    if (!ownsGesture(epoch)) return
    const x = at.x + q.x
    const y = at.y + q.y
    if (x < 0 || y < 0 || x >= W || y >= H) continue
    put(x, y, prefs.opacity < 1 ? blend(q.rgb, seen(y * W + x), prefs.opacity) : q.rgb)
  }
  if (!ownsGesture(epoch)) return
  endStroke()
  stamp.value = null
  invalidate()
}

/** Writes the status line for the pixel under the pointer. */
function describe(p: Pt) {
  if (!inside(p)) {
    hud.x = hud.y = hud.color = hud.draft = null
    hud.painter = hud.paintedAgo = null
    return
  }
  const i = p.y * W + p.x
  hud.x = p.x
  hud.y = p.y
  hud.color = colorAt(i)
  hud.draft = seen(i) !== colorAt(i) ? seen(i) : null
  const who = whoPainted(i)
  hud.painter = who?.painter ?? null
  hud.paintedAgo = who && chain.head !== null ? agoBlocks(chain.head - who.block) : null
}

function agoBlocks(n: number): string {
  const s = Math.max(0, n) * chain.interval
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

// --- what the page can ask of the view ------------------------------------------------

/** Glides to a paint and outlines it. */
function locate(p: {x0: number; y0: number; x1: number; y1: number}) {
  if (disposed || board.status !== 'ready') return
  const w = p.x1 - p.x0 + 1
  const h = p.y1 - p.y0 + 1
  const s = Math.max(2, Math.min(24, Math.min(cssW / (w * 3), cssH / (h * 3))))
  glide = {from: [scale, (cssW / 2 - ox) / scale, (cssH / 2 - oy) / scale], to: [s, p.x0 + w / 2, p.y0 + h / 2], at: performance.now()}
  located = {p, at: performance.now()}
  invalidate()
}

/** Where the mirror axes cross: the middle of the view, when mirroring is turned on. */
function centre(): Pt {
  const c = toCanvas(cssW / 2, cssH / 2)
  return {x: Math.max(0, Math.min(W - 1, c.x)), y: Math.max(0, Math.min(H - 1, c.y))}
}

defineExpose({locate, fit, zoomIn: () => { glide = null; zoomAt(1.5) }, zoomOut: () => { glide = null; zoomAt(1 / 1.5) }, centre, setSpace: (on: boolean) => (space = on)})

// --- wiring ---------------------------------------------------------------------------

let ro: ResizeObserver | null = null
const offs: (() => void)[] = []
let themeObserver: MutationObserver | null = null

function resize() {
  const el = host.value
  const c = cv.value
  if (!el || !c) return
  const r = el.getBoundingClientRect()
  const first = cssW === 0
  const cx = cssW ? (cssW / 2 - ox) / scale : 0
  const cy = cssH ? (cssH / 2 - oy) / scale : 0
  cssW = r.width
  cssH = r.height
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  const bw = Math.round(cssW * dpr)
  const bh = Math.round(cssH * dpr)
  // Setting a canvas's size wipes it, so it is set only when it changed.
  const wiped = c.width !== bw || c.height !== bh
  if (c.width !== bw) c.width = bw
  if (c.height !== bh) c.height = bh
  // The canvas point at the centre stays at the centre. `cx` is already a
  // point, not a pixel, so it is placed as it is: centerOn would add half a
  // pixel, and the side column's slide fires a resize every frame, which walked
  // the view 12 canvas pixels down and right on every fold.
  if (board.status === 'ready' && W && H) {
    if (first || !viewed) reconcileView()
    else setView(scale, cssW / 2 - cx * scale, cssH / 2 - cy * scale)
  }
  // Redrawn now, not on the next frame. A ResizeObserver reports after layout
  // and before paint, so drawing here puts the picture back in the same frame
  // the resize wiped it. Waiting a frame showed the dark board behind it on
  // every frame of the side column's slide: the canvas flashed black.
  if (wiped) {
    cancelAnimationFrame(frame)
    render(performance.now())
  } else invalidate()
}

let viewed = false
watch(
  () => board.status,
  (s) => {
    if (s !== 'ready') resetViewContext()
    if (s === 'ready') reconcileView()
    refreshDetails()
    invalidate()
    drawMiniSoon()
  },
  {flush: 'sync'},
)
watch(() => prefs.tool, () => { stopGesture(); invalidate() }, {flush: 'sync'})
// A new head can age a selected paint while its live log read is still pending.
watch(() => [chain.head, chain.interval] as const, refreshDetails)
watch(
  () => [prefs.grid, prefs.showDraft, prefs.mirrorX, prefs.mirrorY, prefs.tool, guide.visible, guide.opacity, guide.x, guide.y, guide.picture, stamp.value],
  invalidate,
)

const cursor = computed(() => {
  if (panning) return 'grabbing'
  if (props.bare) return 'grab'
  if (prefs.tool === 'pan') return 'grab'
  if (prefs.tool === 'picker') return 'copy'
  return 'crosshair'
})

onMounted(() => {
  window.addEventListener('keydown', onKeyPick)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  ctx = cv.value!.getContext('2d')
  readCss()
  ro = new ResizeObserver(resize)
  ro.observe(host.value!)
  resize()
  // The pixel under a still pointer can change under it (a fill, an undo,
  // someone else's paint), so the status line is rewritten with the layers.
  offs.push(
    onChanged(() => {
      refreshDetails()
      invalidate()
      drawMiniSoon()
    }),
  )
  offs.push(
    onLayers(() => {
      refreshDetails()
      invalidate()
    }),
  )
  offs.push(onAttributionChanged(refreshDetails))
  offs.push(
    onArrived((ps) => {
      if (disposed || board.status !== 'ready') return
      const now = performance.now()
      for (const p of ps.slice(-40)) fresh.push({p, at: now})
      invalidate()
    }),
  )
  themeObserver = new MutationObserver(() => {
    readCss()
    invalidate()
  })
  themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']})
})

onBeforeUnmount(() => {
  disposed = true
  resetViewContext()
  window.removeEventListener('keydown', onKeyPick)
  window.removeEventListener('blur', onBlur)
  document.removeEventListener('visibilitychange', onVisibility)
  ro?.disconnect()
  offs.forEach((f) => f())
  themeObserver?.disconnect()
  cancelAnimationFrame(frame)
  clearInterval(sprayTimer)
})

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
}
function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (!files?.length) return
  // File drags are accepted by the board. Keep unsupported files from
  // falling through to the browser's default file-drop action.
  e.preventDefault()
  for (const file of files) {
    if (!isImage(file)) continue
    emit('drop-image', file)
    break
  }
}

const zoomLabel = computed(() => (hud.zoom >= 1 ? `${Math.round(hud.zoom * 100)}%` : `${Math.round(hud.zoom * 100)}%`))
</script>

<template>
  <div ref="host" class="board relative overflow-hidden rounded-[10px] border border-line" @dragover="onDragOver" @drop="onDrop">
    <canvas
      ref="cv"
      class="absolute inset-0 w-full h-full block"
      :style="{cursor, touchAction: 'none'}"
      data-testid="board"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onCancel"
      @lostpointercapture="onCancel"
      @pointerleave="onLeave"
      @wheel="onWheel"
      @contextmenu.prevent
    />

    <!-- Loading: the rows arrive in ten slices, and the bar says how many are in. -->
    <Transition name="fade">
      <div v-if="board.status === 'loading'" class="absolute inset-x-0 top-0 pointer-events-none">
        <div class="h-[3px] bg-line/60 overflow-hidden">
          <div class="h-full transition-[width] duration-300" :style="{width: `${Math.max(4, board.progress * 100)}%`, background: 'var(--plasma)'}" />
        </div>
        <div class="m-3 inline-flex items-center gap-2 glass rounded-full px-3 py-1 text-[12px]">
          <Icon name="refresh" :size="12" class="spin" /> Reading the canvas from the chain, {{ Math.round(board.progress * 100) }}%
        </div>
      </div>
    </Transition>
    <div v-if="board.status === 'error'" class="absolute inset-0 grid place-items-center p-6 text-center">
      <div class="pop p-4 max-w-[360px] grid gap-2 text-[13px]">
        <span style="color: var(--danger)">The canvas could not be read.</span>
        <span class="text-dim break-words">{{ board.error }}</span>
      </div>
    </div>

    <!-- Placing a stamp: say so, and how to stop. -->
    <div v-if="stamp && !bare" class="absolute top-3 left-1/2 -translate-x-1/2 glass rounded-full px-3 py-1 text-[12px] flex items-center gap-2">
      <Icon name="image" :size="13" /> Click to place {{ stamp.w }} x {{ stamp.h }}
      <button class="link" @click="stamp = null">Cancel</button>
    </div>

    <!-- The selected pixel, and who last painted it. -->
    <Transition name="fade">
      <div v-if="picked && !bare" class="pick pop absolute top-2 left-2 p-3 grid gap-2 text-[12.5px]" data-testid="pick" @pointerdown.stop>
        <div class="flex items-center gap-2">
          <span class="w-5 h-5 rounded border border-line-strong shrink-0" :style="{background: toHex(picked.color)}" />
          <span class="mono">{{ picked.x }}, {{ picked.y }}</span>
          <span class="mono text-dim uppercase">{{ toHex(picked.color) }}</span>
          <button class="ml-auto text-dim hover:text-fg" title="Close (Esc)" @click="clearPick"><Icon name="x" :size="14" /></button>
        </div>
        <div v-if="picked.painter" class="grid gap-1">
          <span class="ledger">Last painted by</span>
          <div class="flex items-center gap-2 min-w-0">
            <Avatar :seed="picked.painter" :size="22" />
            <Who :address="picked.painter" :head="8" :tail="6" data-testid="pick-painter" />
            <span v-if="same(picked.painter, wallet.address)" class="chip shrink-0" style="color: var(--znn-ink); background: color-mix(in srgb, var(--znn) 13%, transparent)">You</span>
          </div>
          <span class="text-dim">{{ picked.ago }}, block {{ picked.block }}</span>
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <a v-if="picked.tx && explorerUrl(`/tx/${picked.tx}`)" class="link" :href="explorerUrl(`/tx/${picked.tx}`)!" target="_blank" rel="noreferrer noopener">The paint</a>
            <a v-if="explorerUrl(`/address/${picked.painter}`)" class="link" :href="explorerUrl(`/address/${picked.painter}`)!" target="_blank" rel="noreferrer noopener">The painter</a>
          </div>
        </div>
        <p v-else class="text-dim">{{ unknownWhy }}</p>
        <div v-if="picked.draft !== null" class="flex items-center gap-2 border-t border-line pt-2">
          <span class="w-4 h-4 rounded border border-line-strong shrink-0" :style="{background: toHex(picked.draft)}" />
          <span class="text-dim">Your draft paints it <span class="mono uppercase text-fg">{{ toHex(picked.draft) }}</span></span>
        </div>
      </div>
    </Transition>

    <!-- What is under the pointer. -->
    <div v-if="!bare" class="absolute left-2 bottom-2 right-[170px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] pointer-events-none">
      <span class="glass rounded-full px-2.5 py-0.5 mono">{{ zoomLabel }}</span>
      <span v-if="hud.x !== null" class="glass rounded-full pl-1 pr-2.5 py-0.5 mono flex items-center gap-1.5" data-testid="hud">
        <span class="w-3.5 h-3.5 rounded-full border border-line-strong" :style="{background: toHex(hud.color ?? 0xffffff)}" />
        {{ hud.x }}, {{ hud.y }}
        <span class="text-dim">{{ toHex(hud.color ?? 0xffffff) }}</span>
        <template v-if="hud.draft !== null">
          <Icon name="arrow" :size="11" class="text-dim" />
          <span class="w-3.5 h-3.5 rounded-full border border-line-strong" :style="{background: toHex(hud.draft)}" />
          <span>{{ toHex(hud.draft) }}</span>
          <span class="text-dim font-sans">in your draft</span>
        </template>
      </span>
      <span v-if="hud.painter" class="glass rounded-full pl-1 pr-2.5 py-0.5 flex items-center gap-1.5">
        <Avatar :seed="hud.painter" :size="14" />
        <Who :address="hud.painter" />
        <span class="text-dim">{{ hud.paintedAgo }}</span>
      </span>
    </div>

    <!-- Where the view is, on the whole canvas. Drag it to move. -->
    <canvas
      v-show="!bare"
      ref="mini"
      class="minimap absolute right-2 bottom-2 w-[150px] h-[150px] rounded-md border border-line-strong cursor-pointer"
      title="The whole canvas. Click or drag to move the view."
      @pointerdown="miniJump"
      @pointermove="miniJump"
    />
  </div>
</template>

<style scoped>
.pick {
  width: min(280px, calc(100% - 16px));
  z-index: 3;
}
.board {
  background: var(--sunk);
  box-shadow: var(--edge), var(--shadow-panel);
  user-select: none;
  -webkit-user-select: none;
}
.minimap {
  background: #2b2e33;
  box-shadow: var(--shadow-pop);
  image-rendering: auto;
}
@media (max-width: 639px) {
  .minimap {
    width: 96px;
    height: 96px;
  }
}
</style>
