// The canvas as the chain has it, kept in this tab.
//
// Loading is a snapshot plus a replay. The snapshot is the contract's state,
// read with `chunk()` in ten calls of ten thousand slots; the replay is every
// Painted event after the block number read *before* the snapshot. The
// snapshot may already include some of those events, and replaying them is
// harmless: events apply in chain order and the last write to a pixel wins, so
// the result is the chain's state at the head, whichever block each chunk was
// read at. No archive state is needed, which a pruned node would not have.
//
// After that, every block's events are applied as the block lands (chain.ts
// beats once per momentum), and whoever listens is told what arrived, so the
// page can mark it.
//
// Who painted each pixel is not in the contract's state, only in its events,
// so it is known for pixels painted since the history window began (a day, or
// the deployment, whichever is later) and unknown before.
//
// The pixel arrays are deliberately not reactive: a million entries behind a
// proxy would make every read a trap. `board` is the small reactive summary.

import {reactive, shallowRef, watch} from 'vue'
import {decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Address, type Hex} from 'viem'
import {MOZAIC_ABI} from './abi'
import {endpoint, ready} from './endpoint'
import {onBlock} from './chain'
import {decodePixels, PER_SLOT, type Px} from './codec'

/** About a day of momentums at the measured fifteen seconds each. */
export const HISTORY_BLOCKS = 5760
const LOG_SPAN = 5000
const SLOTS_PER_CALL = 10_000

const PAINTED_TOPIC = keccak256(toBytes('Painted(address,uint256,bytes)'))
/** The router's: who a paint through it is for, logged just before the canvas's Painted. */
const PAINTED_BY_TOPIC = keccak256(toBytes('PaintedBy(address,address,uint256)'))
/** The owner cleared the canvas: from this block on, everything is white. */
const CLEARED_TOPIC = keccak256(toBytes('Cleared(uint256)'))

/** What the logs are read from: the canvas, and its router when it has one. */

export interface Paint {
  tx: Hex
  painter: Address
  count: number
  block: number
  /** The bounding box of what it painted, for locating it on the canvas. */
  x0: number
  y0: number
  x1: number
  y1: number
}

export const board = reactive({
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  /** 0..1 while the snapshot loads. */
  progress: 0,
  error: null as string | null,
  width: 0,
  height: 0,
  /** Every event up to and including this block has been applied. */
  syncedTo: 0,
  /** The first block of the history window, once it has loaded. */
  historyFrom: null as number | null,
  historyLoading: false,
  painted: null as bigint | null,
  /** The block the canvas was last cleared in, when a clear is in what this page has read. */
  clearedAt: null as number | null,
  /** What the contract holds: every paint's payment not yet withdrawn. */
  balance: null as bigint | null,
})

/** Paints in the history window and since, oldest first. */
export const paints = shallowRef<Paint[]>([])

// --- the pixels -----------------------------------------------------------------

export let W = 0
export let H = 0
let rgba = new Uint8ClampedArray(0)
let image: ImageData | null = null
/** The canvas at one pixel per pixel, which the view scales. */
export const surface = document.createElement('canvas')
const sctx = surface.getContext('2d', {willReadFrequently: false})!

/** Per pixel: 1 + index into `painterList`, or 0 when unknown. */
let painterOf = new Uint32Array(0)
let blockOf = new Uint32Array(0)
const painterList: Address[] = []
const painterIds = new Map<string, number>()

/**
 * A pixel's colour. Blank is white, as the contract has it: a pixel never
 * painted and one painted white are the same zero in storage. The page draws
 * blank as see-through, over the checkerboard, so a blank canvas reads as
 * empty rather than as white paint (the owner's call, 2026-09-29).
 */
export function colorAt(index: number): number {
  const o = index * 4
  return rgba[o + 3] === 0 ? 0xffffff : (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]
}

/** Who last painted a pixel and in which block, when it was in the window. */
export function whoPainted(index: number): {painter: Address; block: number} | null {
  const id = painterOf[index]
  return id ? {painter: painterList[id - 1], block: blockOf[index]} : null
}

/** A storage slot holds ten white pixels, so it is zero on chain. */
export function slotBlank(slot: number): boolean {
  for (let k = 0; k < PER_SLOT; k++) if (colorAt(slot * PER_SLOT + k) !== 0xffffff) return false
  return true
}

function allocate(w: number, h: number) {
  W = w
  H = h
  // Transparent throughout: a canvas before any paint is blank.
  rgba = new Uint8ClampedArray(w * h * 4)
  image = new ImageData(rgba, w, h)
  surface.width = w
  surface.height = h
  sctx.putImageData(image, 0, 0)
  painterOf = new Uint32Array(w * h)
  blockOf = new Uint32Array(w * h)
  painterList.length = 0
  painterIds.clear()
}

let dirty: {x0: number; y0: number; x1: number; y1: number} | null = null

/**
 * The owner cleared the canvas in `block`. Live, every pixel goes white at
 * once, as it did on chain. Either way, nobody painted what is there before
 * that block any more, so those painters are forgotten; a paint later than
 * the clear, already applied by the live sync, keeps its painter.
 */
function cleared(block: number, pixels: boolean, owns: () => boolean) {
  if (board.clearedAt === null || block > board.clearedAt) board.clearedAt = block
  if (!owns()) return
  if (pixels) {
    rgba.fill(0)
    dirty = {x0: 0, y0: 0, x1: W - 1, y1: H - 1}
  }
  for (let i = 0; i < blockOf.length; i++) {
    if (blockOf[i] <= block) {
      painterOf[i] = 0
      blockOf[i] = 0
    }
  }
}

function set(index: number, rgb: number) {
  const o = index * 4
  rgba[o] = rgb >> 16
  rgba[o + 1] = (rgb >> 8) & 0xff
  rgba[o + 2] = rgb & 0xff
  rgba[o + 3] = rgb === 0xffffff ? 0 : 255
  const x = index % W
  const y = (index - x) / W
  if (!dirty) dirty = {x0: x, y0: y, x1: x, y1: y}
  else {
    if (x < dirty.x0) dirty.x0 = x
    if (x > dirty.x1) dirty.x1 = x
    if (y < dirty.y0) dirty.y0 = y
    if (y > dirty.y1) dirty.y1 = y
  }
}

function flush(owns: () => boolean) {
  if (!dirty || !image) return
  const d = dirty
  dirty = null
  sctx.putImageData(image, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1)
  for (const fn of changed) {
    if (!owns()) return
    fn()
  }
}

// --- who wants to know ----------------------------------------------------------

const changed = new Set<() => void>()
const arrivals = new Set<(p: Paint[]) => void>()

/** Called whenever pixels changed, for a redraw. */
export function onChanged(fn: () => void): () => void {
  changed.add(fn)
  return () => changed.delete(fn)
}

/** Called with paints that arrived live, after the page loaded. */
export function onArrived(fn: (p: Paint[]) => void): () => void {
  arrivals.add(fn)
  return () => arrivals.delete(fn)
}

// --- reading the chain ----------------------------------------------------------

interface BoardContext {
  generation: number
  rpc: string
  chainId: number
  address: Address
  canvas: NonNullable<typeof endpoint.canvas>
  deployBlock: number | null
}

let generation = 0
let logGeneration = 0
let historyGeneration = 0
let active: BoardContext | null = null
let loading: {context: BoardContext; promise: Promise<void>} | null = null
let syncing: {context: BoardContext; epoch: number; promise: Promise<void>; again: boolean} | null = null
let totalsReading: {context: BoardContext; promise: Promise<void>} | null = null
let knownHead: {context: BoardContext; head: number} | null = null
let totalsAt = 0

function current(context: BoardContext): boolean {
  return active === context && generation === context.generation && ready.value &&
    endpoint.rpc === context.rpc && endpoint.chainId === context.chainId &&
    endpoint.contract === context.address && endpoint.canvas === context.canvas
}

function requireCurrent(owns: () => boolean) {
  if (!owns()) throw new Error('Board context changed')
}

function logScope(context: BoardContext) {
  const router = endpoint.router, epoch = logGeneration
  return {epoch, addresses: [context.address, ...(router ? [router] : [])],
    owns: () => current(context) && logGeneration === epoch && endpoint.router === router}
}

function invalidate(): number {
  const selected = ++generation
  logGeneration++
  historyGeneration++
  active = null
  loading = syncing = totalsReading = null
  knownHead = null
  totalsAt = 0
  const owns = () => generation === selected && active === null
  for (const [key, value] of Object.entries({progress: 0, error: null, width: 0, height: 0,
    syncedTo: 0, historyFrom: null, historyLoading: false, painted: null, clearedAt: null, balance: null})) {
    if (!owns()) return selected
    Object.assign(board, {[key]: value})
  }
  if (!owns()) return selected
  paints.value = []
  if (!owns()) return selected
  // Keep layer dimensions and draft storage untouched while the node is unavailable.
  rgba.fill(0)
  painterOf.fill(0)
  blockOf.fill(0)
  painterList.length = 0
  painterIds.clear()
  dirty = null
  if (image) sctx.putImageData(image, 0, 0)
  if (owns()) board.status = 'idle'
  return selected
}

let nextId = 1

/**
 * One JSON-RPC call, never batched: the snapshot's answers are up to a
 * megabyte each, and batching ten of them would hold the first back until the
 * last arrived, which is exactly what the progressive load is there to avoid.
 */
async function rpc<T = any>(context: BoardContext, method: string, params: unknown[], timeoutMs = 60_000, owns = () => current(context)): Promise<T> {
  requireCurrent(owns)
  const res = await fetch(context.rpc, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  requireCurrent(owns)
  if (!res.ok) throw new Error(`${method}: ${res.status} ${res.statusText}`)
  const body = await res.json()
  requireCurrent(owns)
  if (body.error) throw new Error(body.error.message ?? `${method} failed`)
  return body.result as T
}

interface RawLog {
  blockNumber: Hex
  transactionHash: Hex
  topics: Hex[]
  data: Hex
}

/**
 * Painted and PaintedBy logs in [from, to], in one query for both contracts,
 * so a paint and the name it was painted in arrive together and in order.
 * Split when the node refuses a range as too big.
 */
async function logs(context: BoardContext, address: Address[], from: number, to: number, owns: () => boolean): Promise<RawLog[]> {
  requireCurrent(owns)
  if (from > to) return []
  try {
    return await rpc<RawLog[]>(context, 'eth_getLogs', [
      {address, topics: [[PAINTED_TOPIC, PAINTED_BY_TOPIC, CLEARED_TOPIC]], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`},
    ], 60_000, owns)
  } catch (err) {
    requireCurrent(owns)
    // The devnet node caps a query at 20,000 results. Halve and retry.
    if (to - from < 1) throw err
    const mid = Math.floor((from + to) / 2)
    return [...(await logs(context, address, from, mid, owns)), ...(await logs(context, address, mid + 1, to, owns))]
  }
}

async function logsChunked(context: BoardContext, address: Address[], from: number, to: number, owns: () => boolean): Promise<RawLog[]> {
  const out: RawLog[] = []
  for (let a = from; a <= to; a += LOG_SPAN) out.push(...(await logs(context, address, a, Math.min(to, a + LOG_SPAN - 1), owns)))
  return out
}

/**
 * Applies Painted logs in chain order; `pixels` false records who and when
 * only. A paint through the router is credited to the artist its PaintedBy
 * named, which for a paint session is the wallet that funded the session:
 * the canvas itself only ever sees the router.
 */
function apply(raw: RawLog[], pixels: boolean, owns: () => boolean): Paint[] {
  const out: Paint[] = []
  const buf: Px[] = []
  const artistOf = new Map<string, Address>()
  for (const l of raw) {
    if (!owns()) return out
    if (l.topics[0] === PAINTED_BY_TOPIC) {
      artistOf.set(l.transactionHash, `0x${l.topics[1].slice(26)}` as Address)
      continue
    }
    if (l.topics[0] === CLEARED_TOPIC) {
      cleared(parseInt(l.blockNumber, 16), pixels, owns)
      continue
    }
    const sender = `0x${l.topics[1].slice(26)}` as Address
    const painter = artistOf.get(l.transactionHash) ?? sender
    const data = l.data.slice(2)
    // (uint256 count, bytes pixels): the bytes' length is the third word.
    const len = parseInt(data.slice(128, 192), 16)
    buf.length = 0
    decodePixels(data.slice(192, 192 + len * 2), buf)
    let id = painterIds.get(painter.toLowerCase())
    if (!id) {
      painterList.push(painter)
      id = painterList.length
      painterIds.set(painter.toLowerCase(), id)
    }
    const block = parseInt(l.blockNumber, 16)
    let x0 = W, y0 = H, x1 = 0, y1 = 0
    for (const p of buf) {
      if (p.index >= W * H) continue
      if (pixels) set(p.index, p.rgb)
      // The history window loads after the live sync has started, so a
      // pixel may already carry a newer painter than the event being read.
      if (blockOf[p.index] <= block) {
        painterOf[p.index] = id
        blockOf[p.index] = block
      }
      const x = p.index % W
      const y = (p.index - x) / W
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    out.push({tx: l.transactionHash, painter, count: buf.length, block, x0, y0, x1, y1})
  }
  return out
}

function applyChunk(result: Hex) {
  const hex = decodeFunctionResult({abi: MOZAIC_ABI, functionName: 'chunk', data: result}) as Hex
  // 36 bytes an entry: slot (4), then the slot's 32-byte value, in which pixel
  // k is bits 24k..24k+23 counted from the right, stored XOR 0xFFFFFF.
  for (let o = 2; o + 72 <= hex.length; o += 72) {
    const slot = parseInt(hex.slice(o, o + 8), 16)
    const value = hex.slice(o + 8, o + 72)
    for (let k = 0; k < PER_SLOT; k++) {
      const end = 64 - k * 6
      set(slot * PER_SLOT + k, parseInt(value.slice(end - 6, end), 16) ^ 0xffffff)
    }
  }
}

/** Loads the canvas from scratch; only the current pending snapshot is shared. */
export function load(): Promise<void> {
  if (loading && current(loading.context)) return loading.promise
  const canvas = endpoint.canvas, address = endpoint.contract, chainId = endpoint.chainId, rpc = endpoint.rpc
  const selected = invalidate()
  if (!ready.value || !canvas || !address || chainId === null || generation !== selected ||
    endpoint.rpc !== rpc || endpoint.canvas !== canvas || endpoint.contract !== address || endpoint.chainId !== chainId) return Promise.resolve()
  const context: BoardContext = {generation: selected, rpc, chainId, address, canvas, deployBlock: endpoint.deployBlock}
  active = context
  let accept!: () => void
  let decline!: (reason: unknown) => void
  const completed = new Promise<void>((resolve, reject) => {accept = resolve; decline = reject})
  const promise = completed.finally(() => {
    if (loading?.promise === promise) loading = null
  })
  loading = {context, promise}
  void snapshot(context).then(accept, decline)
  return promise
}

async function snapshot(context: BoardContext) {
  const owns = () => current(context), canvas = context.canvas
  try {
    board.status = 'loading'
    if (!owns()) return
    board.width = canvas.width
    if (!owns()) return
    board.height = canvas.height
    if (!owns()) return
    allocate(canvas.width, canvas.height)
    if (!owns()) return
    for (const fn of changed) {
      if (!owns()) return
      fn()
    }
    const head = parseInt(await rpc<Hex>(context, 'eth_blockNumber', []), 16)
    if (!owns()) return
    const slots = (canvas.width * canvas.height) / PER_SLOT
    const starts: number[] = []
    for (let s = 0; s < slots; s += SLOTS_PER_CALL) starts.push(s)
    let done = 0
    const queue = [...starts]
    // Preserve three workers, ten-thousand-slot calls and progressive rendering.
    await Promise.all(Array.from({length: 3}, async () => {
      for (let start = queue.shift(); start !== undefined; start = queue.shift()) {
        if (!owns()) return
        const data = encodeFunctionData({abi: MOZAIC_ABI, functionName: 'chunk', args: [BigInt(start), BigInt(SLOTS_PER_CALL)]})
        const result = await rpc<Hex>(context, 'eth_call', [{to: context.address, data}, 'latest'])
        if (!owns()) return
        applyChunk(result)
        flush(owns)
        if (!owns()) return
        board.progress = ++done / starts.length
      }
    }))
    if (!owns()) return
    board.syncedTo = head
    if (!owns()) return
    board.status = 'ready'
    if (!owns()) return
    void refreshTotals(true)
    void sync()
    void loadHistory(context, head)
  } catch (err: any) {
    if (!owns()) return
    board.status = 'error'
    if (owns()) board.error = err?.message ?? String(err)
  }
}

async function loadHistory(context: BoardContext, head: number) {
  const selected = ++historyGeneration, scope = logScope(context)
  const owns = () => scope.owns() && historyGeneration === selected
  if (!owns()) return
  board.historyLoading = true
  try {
    if (!owns()) return
    const from = Math.max(context.deployBlock ?? 0, head - HISTORY_BLOCKS, 0)
    const raw = await logsChunked(context, scope.addresses, from, head, owns)
    if (!owns()) return
    // History changes attribution only; newer live pixels and painters survive.
    const older = apply(raw, false, owns)
    if (!owns()) return
    paints.value = [...older, ...paints.value.filter((p) => p.block > head)]
    if (owns()) board.historyFrom = from
  } catch {
    /* the activity list says it could not be read; the canvas is unaffected */
  } finally {
    if (owns()) board.historyLoading = false
  }
}

/** Apply every event through the beat's head; hints belong to this board only. */
export function sync(head?: number): Promise<void> {
  const context = active
  if (!context || !current(context)) return Promise.resolve()
  if (head !== undefined) knownHead = {context, head}
  if (board.status !== 'ready') return Promise.resolve()
  const scope = logScope(context)
  if (syncing?.context === context && syncing.epoch === scope.epoch) {
    syncing.again = true
    return syncing.promise
  }
  let accept!: () => void
  let decline!: (reason: unknown) => void
  const completed = new Promise<void>((resolve, reject) => {accept = resolve; decline = reject})
  const promise = completed.finally(() => {
    if (syncing?.promise === promise) syncing = null
  })
  const owner = {context, epoch: scope.epoch, promise, again: false}
  syncing = owner
  const run = async () => {
    do {
      owner.again = false
      if (!scope.owns() || board.status !== 'ready') return
      try {
        const hinted = knownHead?.context === context ? knownHead.head : null
        knownHead = null
        const target = hinted ?? parseInt(await rpc<Hex>(context, 'eth_blockNumber', [], 60_000, scope.owns), 16)
        if (!scope.owns()) return
        if (target <= board.syncedTo) continue
        const raw = await logsChunked(context, scope.addresses, board.syncedTo + 1, target, scope.owns)
        if (!scope.owns()) return
        const arrived = apply(raw, true, scope.owns)
        if (!scope.owns()) return
        flush(scope.owns)
        if (!scope.owns()) return
        board.syncedTo = target
        if (!scope.owns()) return
        if (arrived.length) {
          paints.value = [...paints.value, ...arrived]
          for (const fn of arrivals) {
            if (!scope.owns()) return
            fn(arrived)
          }
        }
      } catch {
        /* the next block tries again from the same place */
      }
    } while (owner.again && scope.owns())
  }
  void run().then(accept, decline)
  return promise
}

/** One current counter read, at most once a minute except the snapshot refresh. */
function refreshTotals(force = false): Promise<void> {
  const context = active
  if (!context || !current(context) || board.status !== 'ready') return Promise.resolve()
  if (totalsReading?.context === context) return totalsReading.promise
  if (!force && Date.now() - totalsAt < 60_000) return Promise.resolve()
  totalsAt = Date.now()
  let accept!: () => void
  const completed = new Promise<void>(resolve => {accept = resolve})
  const promise = completed.finally(() => {
    if (totalsReading?.promise === promise) totalsReading = null
  })
  totalsReading = {context, promise}
  const read = async () => {
    try {
      const [painted, balance] = await Promise.all([
        rpc<Hex>(context, 'eth_call', [{to: context.address, data: encodeFunctionData({abi: MOZAIC_ABI, functionName: 'painted'})}, 'latest']),
        rpc<Hex>(context, 'eth_getBalance', [context.address, 'latest']),
      ])
      if (!current(context)) return
      board.painted = BigInt(painted)
      if (current(context)) board.balance = BigInt(balance)
    } catch {
      /* totals are decoration; the original minute cooldown still applies */
    }
  }
  void read().then(accept)
  return promise
}

onBlock((head) => {
  void sync(head)
  void refreshTotals()
})

watch(
  () => [ready.value, endpoint.rpc, endpoint.chainId, endpoint.contract, endpoint.canvas] as const,
  () => {void load()},
  {flush: 'sync'},
)

// Router discovery can finish after the snapshot starts. Refresh attribution
// and pending log reads without resetting the snapshot or a person's draft.
watch(() => endpoint.router, () => {
  logGeneration++
  historyGeneration++
  syncing = null
  const context = active
  if (!context || !current(context) || board.status !== 'ready') return
  void sync()
  void loadHistory(context, board.syncedTo)
}, {flush: 'sync'})

/** The canvas, or a part of it, as a PNG. */
export function exportPng(x = 0, y = 0, w = W, h = H): Promise<Blob | null> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(surface, x, y, w, h, 0, 0, w, h)
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'))
}
