// What a person has drawn and not yet paid for, and what they have sent and
// not yet seen executed.
//
// Drawing is free and local; painting is a transaction. So every tool writes
// into a draft, the draft is shown over the canvas, and one button pays for
// the lot. Satoshi's Place worked the same way, and it is the only way large
// work is affordable to try: undo costs nothing until the draft is sent.
//
// The draft may be the whole canvas. It is two typed arrays the size of the
// canvas rather than a Map: a million-entry Map costs tens of megabytes and
// a hash per read, where these cost 5 MB and an index. It is kept across
// reloads in IndexedDB, as bytes, because localStorage holds about five
// megabytes of strings and a full draft is twelve.
//
// A pixel the draft sets to the colour the canvas already has costs nothing
// and is not sent. That count is kept as pixels change, and recounted in full
// only when the canvas itself changes, once a block.

import {reactive, watch} from 'vue'
import {board, colorAt, onChanged, W, H} from './board'
import {endpoint} from './endpoint'
import type {Px} from './codec'
import {toast} from './toast'
import * as idb from './idb'

/** The whole canvas. */
export const maxDraft = () => W * H

/** One pixel per canvas pixel: its colour, and whether it is set at all. */
class Layer {
  color = new Uint32Array(0)
  has = new Uint8Array(0)
  size = 0
  readonly surface = document.createElement('canvas')
  private img: ImageData | null = null
  private dirty: number[] = []
  private allDirty = false

  reset() {
    this.color = new Uint32Array(W * H)
    this.has = new Uint8Array(W * H)
    this.size = 0
    this.surface.width = W
    this.surface.height = H
    this.img = new ImageData(W, H)
    this.dirty = []
    this.allDirty = false
  }

  get(i: number): number | undefined {
    return this.has[i] ? this.color[i] : undefined
  }

  set(i: number, rgb: number) {
    if (!this.has[i]) {
      this.has[i] = 1
      this.size++
    }
    this.color[i] = rgb
    this.mark(i)
  }

  delete(i: number) {
    if (!this.has[i]) return
    this.has[i] = 0
    this.size--
    this.mark(i)
  }

  private mark(i: number) {
    // Past a quarter of the canvas, redraw it whole rather than keep a list
    // as long as the canvas.
    if (this.allDirty) return
    if (this.dirty.length > (W * H) / 4) this.allDirty = true
    else this.dirty.push(i)
  }

  /** Redraw captured saved pixels after a partition is attached or restored. */
  refresh() { this.allDirty = true }

  /** Pushes what changed into the surface the view draws. */
  paint() {
    const img = this.img
    if (!img || (!this.dirty.length && !this.allDirty)) return
    const d = img.data
    const write = (i: number) => {
      const o = i * 4
      if (!this.has[i]) d[o + 3] = 0
      else {
        const v = this.color[i]
        d[o] = v >> 16
        d[o + 1] = (v >> 8) & 0xff
        d[o + 2] = v & 0xff
        d[o + 3] = 255
      }
    }
    const ctx = this.surface.getContext('2d')!
    if (this.allDirty) {
      for (let i = 0; i < W * H; i++) write(i)
      ctx.putImageData(img, 0, 0)
    } else {
      let x0 = W, y0 = H, x1 = -1, y1 = -1
      for (const i of this.dirty) {
        write(i)
        const x = i % W
        const y = (i - x) / W
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      ctx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }
    this.dirty = []
    this.allDirty = false
  }
}

export const draft = new Layer()
export const pending = new Layer()
export const draftSurface = draft.surface
export const pendingSurface = pending.surface

export const draftState = reactive({
  size: 0,
  /** Draft pixels that differ from the canvas: what a paint would send. */
  changed: 0,
  pending: 0,
  canUndo: false,
  canRedo: false,
  /** Bumped on any change, for what recomputes from the draft (the quote). */
  version: 0,
})

const layerListeners = new Set<() => void>()
export function onLayers(fn: () => void): () => void {
  layerListeners.add(fn)
  return () => layerListeners.delete(fn)
}

/** Draft pixels that differ from the canvas, kept as pixels change. */
let changed = 0
const costs = (i: number) => draft.has[i] === 1 && draft.color[i] !== colorAt(i)

let frame = 0
let recountAll = false

/** Redraws the layers and publishes the counts, once a frame at most. */
export function schedule() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draft.paint()
    pending.paint()
    if (recountAll) {
      recountAll = false
      changed = 0
      for (let i = 0; i < draft.has.length; i++) if (costs(i)) changed++
    }
    draftState.size = draft.size
    draftState.changed = changed
    draftState.pending = pending.size
    draftState.canUndo = undoStack.length > 0
    draftState.canRedo = redoStack.length > 0
    draftState.version++
    save()
    layerListeners.forEach((fn) => fn())
  })
}

// Someone else's paint can make a draft pixel free, or make one cost again.
onChanged(() => {
  recountAll = true
  schedule()
})

/** Every change to the draft goes through here, so the count stays right. */
function write(i: number, rgb: number | undefined) {
  if (costs(i)) changed--
  if (rgb === undefined) draft.delete(i)
  else draft.set(i, rgb)
  if (costs(i)) changed++
  if (ownsDraft() && !activeDraft!.record.loaded) activeDraft!.record.edited.add(i)
}

// --- strokes, undo and redo ------------------------------------------------------

/**
 * What one stroke changed: each index it touched first, and what the draft
 * held there before (-1 for nothing). Parallel typed arrays, grown as needed,
 * because a fill of the whole canvas is a stroke of a million entries.
 */
class Stroke {
  idx = new Int32Array(256)
  prev = new Int32Array(256)
  n = 0
  push(i: number, prev: number) {
    if (this.n === this.idx.length) {
      const grow = (a: Int32Array) => {
        const b = new Int32Array(a.length * 2)
        b.set(a)
        return b
      }
      this.idx = grow(this.idx)
      this.prev = grow(this.prev)
    }
    this.idx[this.n] = i
    this.prev[this.n] = prev
    this.n++
  }
}

const undoStack: Stroke[] = []
const redoStack: Stroke[] = []
/** Undo keeps about this many pixel changes in all, oldest dropped first: 32 MB of history. */
const UNDO_BUDGET = 4_000_000
let stroke: Stroke | null = null
let touched = new Uint8Array(0)

export function beginStroke() {
  stroke = new Stroke()
  if (touched.length !== W * H) touched = new Uint8Array(W * H)
}

function touch(i: number) {
  if (!stroke || touched[i]) return
  touched[i] = 1
  stroke.push(i, draft.has[i] ? draft.color[i] : -1)
}

/** Sets a draft pixel. */
export function put(x: number, y: number, rgb: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return true
  const i = y * W + x
  if (draft.has[i] && draft.color[i] === rgb) return true
  touch(i)
  write(i, rgb)
  schedule()
  return true
}

export function remove(x: number, y: number) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = y * W + x
  if (!draft.has[i]) return
  touch(i)
  write(i, undefined)
  schedule()
}

function trim() {
  let total = undoStack.reduce((s, k) => s + k.n, 0) + redoStack.reduce((s, k) => s + k.n, 0)
  while (total > UNDO_BUDGET && undoStack.length > 1) total -= undoStack.shift()!.n
}

export function endStroke() {
  if (stroke) {
    for (let k = 0; k < stroke.n; k++) touched[stroke.idx[k]] = 0
    if (stroke.n) {
      undoStack.push(stroke)
      if (undoStack.length > 200) undoStack.shift()
      redoStack.length = 0
      trim()
    }
  }
  stroke = null
  schedule()
}

function replay(from: Stroke[], to: Stroke[]) {
  const s = from.pop()
  if (!s) return
  const inverse = new Stroke()
  for (let k = s.n - 1; k >= 0; k--) {
    const i = s.idx[k]
    inverse.push(i, draft.has[i] ? draft.color[i] : -1)
    write(i, s.prev[k] === -1 ? undefined : s.prev[k])
  }
  to.push(inverse)
  schedule()
}

export const undo = () => replay(undoStack, redoStack)
export const redo = () => replay(redoStack, undoStack)

/** Undo would reach back past pixels that have been paid for. */
export function forgetHistory() {
  undoStack.length = redoStack.length = 0
  schedule()
}

export function clearDraft() {
  if (!draft.size) return
  beginStroke()
  for (let i = 0; i < draft.has.length; i++) if (draft.has[i]) remove(i % W, (i - (i % W)) / W)
  endStroke()
}

/** Drops draft pixels that match the canvas already: they would cost nothing, and they clutter the view. */
export function pruneDraft() {
  beginStroke()
  for (let i = 0; i < draft.has.length; i++) if (draft.has[i] && draft.color[i] === colorAt(i)) remove(i % W, (i - (i % W)) / W)
  endStroke()
}

/** The composite a tool sees: the draft over what is pending over the canvas. */
export const seen = (i: number) => (draft.has[i] ? draft.color[i] : pending.has[i] ? pending.color[i] : colorAt(i))

/** What the draft would send, in index order: its pixels that differ from the canvas. */
export function outgoing(): Px[] {
  const out: Px[] = []
  for (let i = 0; i < draft.has.length; i++) if (draft.has[i] && draft.color[i] !== colorAt(i)) out.push({index: i, rgb: draft.color[i]})
  return out
}

/** A batch has been signed and sent: it leaves the draft and shows as pending. */
export function markSent(g: Px[]) {
  for (const p of g) {
    if (draft.has[p.index] && draft.color[p.index] === p.rgb) write(p.index, undefined)
    pending.set(p.index, p.rgb)
  }
  schedule()
}

/** A batch reverted: back into the draft, unless it has been drawn over since. */
export function markFailed(g: Px[]) {
  for (const p of g) {
    if (pending.get(p.index) !== p.rgb) continue
    pending.delete(p.index)
    if (!draft.has[p.index]) write(p.index, p.rgb)
  }
  schedule()
}

/** Batches executed, waiting for their block to be applied to the canvas here. */
const landing: {block: number; pixels: Px[]}[] = []

export function markExecuted(block: number, g: Px[]) {
  landing.push({block, pixels: g})
}

watch(
  () => board.syncedTo,
  (head) => {
    for (let k = landing.length - 1; k >= 0; k--) {
      if (landing[k].block > head) continue
      for (const p of landing[k].pixels) if (pending.get(p.index) === p.rgb) pending.delete(p.index)
      landing.splice(k, 1)
    }
    schedule()
  },
)

// --- keeping the draft across reloads -------------------------------------------

const storeKey = () => (endpoint.chainId && endpoint.contract ? `draft.${endpoint.chainId}.${endpoint.contract.toLowerCase()}` : null)

interface SavedDraft {
  key: string
  has: Uint8Array
  color: Uint32Array
  size: number
  edited: Set<number>
  loaded: boolean
  reading: Promise<void> | null
  writing: Promise<void> | null
  timer: number | undefined
  version: number
  savedVersion: number
  failedWrite: boolean
  legacy: string | null
}

// Keep only the active partition and unfinished/failed work. Detached arrays
// retain unsaved edits without copying a million pixels on every animation frame.
const savedDrafts = new Map<string, SavedDraft>()
let storageEpoch = 0
let activeDraft: {epoch: number; record: SavedDraft} | null = null
const storageContext = () => [board.status, endpoint.rpc, endpoint.chainId, endpoint.contract,
  endpoint.canvas, board.width, board.height] as const
const ownsDraft = () => activeDraft !== null && activeDraft.epoch === storageEpoch &&
  board.status === 'ready' && storeKey() === activeDraft.record.key

function capture(record: SavedDraft) {
  record.has = draft.has
  record.color = draft.color
  record.size = draft.size
}

function release(record: SavedDraft) {
  const safe = record.loaded ? !record.failedWrite && record.version === record.savedVersion :
    record.size === 0 && record.edited.size === 0
  if (activeDraft?.record !== record && safe && !record.reading && !record.writing &&
    record.timer === undefined && savedDrafts.get(record.key) === record) savedDrafts.delete(record.key)
}

function bytesOf(record: SavedDraft): Uint8Array {
  // Count the captured membership itself: an edit can precede its next frame.
  let count = 0
  for (const present of record.has) count += present
  const bytes = new Uint8Array(count * 6)
  let o = 0
  for (let i = 0; i < record.has.length; i++) {
    if (!record.has[i]) continue
    const c = record.color[i]
    bytes[o++] = i >> 16
    bytes[o++] = (i >> 8) & 0xff
    bytes[o++] = i & 0xff
    bytes[o++] = c >> 16
    bytes[o++] = (c >> 8) & 0xff
    bytes[o++] = c & 0xff
  }
  return bytes
}

function queueSave(record: SavedDraft) {
  // A failed/unfinished read must never turn unknown saved data into an empty write.
  if (!record.loaded) return
  clearTimeout(record.timer)
  record.timer = window.setTimeout(() => {
    record.timer = undefined
    const bytes = bytesOf(record), version = record.version
    const previous = record.writing
    const writing = (previous ?? Promise.resolve()).catch(() => {}).then(() => idb.put(record.key, bytes))
    record.writing = writing
    void writing.then(() => {
      record.savedVersion = Math.max(record.savedVersion, version)
      record.failedWrite = false
      if (record.legacy !== null) {
        try {
          const key = `mozaic.${record.key}`
          if (localStorage.getItem(key) === record.legacy) localStorage.removeItem(key)
          record.legacy = null
        } catch { /* keep blocked legacy storage untouched */ }
      }
    }, () => {
      // Keep this partition in the tab, including across node/canvas changes.
      record.failedWrite = true
    }).finally(() => {
      if (record.writing === writing) record.writing = null
      release(record)
    })
  }, 1200)
}

function save() {
  if (!ownsDraft()) return
  const record = activeDraft!.record
  capture(record)
  record.version++
  queueSave(record)
}

function publishSaved(record: SavedDraft) {
  if (!ownsDraft() || activeDraft!.record !== record) return
  draft.size = record.size
  draft.refresh()
  recountAll = true
  schedule()
}

function readSaved(record: SavedDraft) {
  if (record.loaded || record.reading) return
  const reading = (async () => {
    let bytes: Uint8Array | null
    try { bytes = await idb.get(record.key) }
    catch {
      // Retain local edits and retry on the next ready context. Do not overwrite
      // a partition whose original bytes could not be read.
      return
    }
    if (bytes !== null && (!(bytes instanceof Uint8Array) || bytes.length % 6 !== 0)) return
    try {
      const legacy = localStorage.getItem(`mozaic.${record.key}`)
      if (legacy && legacy.length % 12 === 0 && /^[0-9a-f]+$/i.test(legacy)) {
        record.legacy = legacy
        if (!bytes) bytes = Uint8Array.from(legacy.match(/../g)!, h => parseInt(h, 16))
        record.version++
      }
    } catch { /* blocked legacy storage is left untouched */ }
    if (bytes) {
      for (let o = 0; o + 6 <= bytes.length; o += 6) {
        const i = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]
        if (i >= record.has.length || record.edited.has(i)) continue
        record.has[i] = 1
        record.color[i] = (bytes[o + 3] << 16) | (bytes[o + 4] << 8) | bytes[o + 5]
      }
    }
    record.size = record.has.reduce((sum, present) => sum + present, 0)
    record.loaded = true
    record.edited.clear()
    if (ownsDraft() && activeDraft!.record === record && record.size) {
      toast(`Your draft of ${record.size.toLocaleString()} pixels is back.`, 'info')
    }
    publishSaved(record)
    if (record.version !== record.savedVersion) queueSave(record)
  })()
  record.reading = reading
  void reading.finally(() => {
    if (record.reading === reading) record.reading = null
    release(record)
  })
}

// Retire synchronously, including A -> B -> A and loading -> loading changes.
// Save timers and reads own captured partition arrays, never the later draft.
watch(storageContext, () => {
  if (activeDraft) {
    const record = activeDraft.record
    capture(record)
    record.version++
    queueSave(record)
    activeDraft = null
    release(record)
  }
  storageEpoch++
}, {flush: 'sync'})

watch(storageContext, ([s]) => {
  if (s === 'loading') {
    draft.reset()
    pending.reset()
    changed = 0
    undoStack.length = redoStack.length = 0
    landing.length = 0
    schedule()
  }
  if (s !== 'ready' || ownsDraft()) return
  const key = storeKey()
  if (!key) return
  let record = savedDrafts.get(key)
  if (!record) {
    record = {key, has: draft.has, color: draft.color, size: draft.size, edited: new Set(),
      loaded: false, reading: null, writing: null, timer: undefined, version: 0,
      savedVersion: 0, failedWrite: false, legacy: null}
    savedDrafts.set(key, record)
  } else if (record.has !== draft.has) {
    for (let i = 0; i < Math.min(record.has.length, draft.has.length); i++) {
      draft.has[i] = record.has[i]
      draft.color[i] = record.color[i]
    }
    draft.size = draft.has.reduce((sum, present) => sum + present, 0)
    capture(record)
  }
  activeDraft = {epoch: storageEpoch, record}
  publishSaved(record)
  readSaved(record)
})
