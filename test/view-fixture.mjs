import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {stripTypeScriptTypes} from 'node:module'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'

// The actual shipped SFC script and tool/color modules run with explicit
// memory-only Vue/compiler-macro, canvas, clock, input and data capabilities.
// This does not compile Vue, start a browser, open storage or contact a node.
export async function fixture(options = {}) {
  const base = new URL('../src/', import.meta.url)
  const text = readFileSync(new URL('components/Board.vue', base), 'utf8')
  const script = /<script setup lang="ts">([\s\S]*?)<\/script>/.exec(text)?.[1]
  if (!script) throw new Error('The shipped Board script is missing')
  const input = /<canvas\b[^>]*data-testid="board"[^>]*\/>/s.exec(text)?.[0]
  if (!input) throw new Error('The actual board input canvas is missing')
  const handlers = Object.fromEntries([...input.matchAll(/@(pointerdown|pointermove|pointerup|pointercancel|lostpointercapture|pointerleave|wheel)="(\w+)"/g)].map(m => [m[1], m[2]]))
  let scope = 'a', next = 1, now = 0, seed = 7, width = options.width ?? 1000, height = options.height ?? 1000
  const timers = new Map(), raf = new Map(), watches = [], mounted = [], unmounted = []
  const windowEvents = new Map(), documentEvents = new Map(), frames = [], writes = [], strokes = []
  const drafts = new Map(), captures = new Set(), listeners = {changed: new Set(), layers: new Set(), attribution: new Set(), arrived: new Set()}
  const location = new URL('http://fixture.invalid/?x=500&y=500&z=8')
  const history = {state: null, writes: [], replaceState(state, unused, url) {this.state = state; this.writes.push(String(url)); location.href = String(url)}}
  const events = map => ({addEventListener(type, fn) {if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn)},
    removeEventListener(type, fn) {map.get(type)?.delete(fn)}})
  const context2d = new Proxy({createImageData(w, h) {return {data: new Uint8ClampedArray(w * h * 4), width: w, height: h}}},
    {get(target, key) {return key in target ? target[key] : () => {}}, set(target, key, value) {target[key] = value; return true}})
  const canvas = () => ({width: 0, height: 0, getContext: () => context2d,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600}),
    setPointerCapture(id) {captures.add(id)}, hasPointerCapture: id => captures.has(id), releasePointerCapture(id) {captures.delete(id)}})
  const document = {...events(documentEvents), documentElement: {}, visibilityState: 'visible',
    createElement(name) {if (name !== 'canvas') throw new Error('Unexpected element capability'); return canvas()}}
  const setTimer = (fn, delay, interval) => {const id = next++; timers.set(id, {fn, delay, interval}); return id}
  const window = {...events(windowEvents), devicePixelRatio: 1,
    setTimeout: (fn, delay) => setTimer(fn, delay, false), setInterval: (fn, delay) => setTimer(fn, delay, true)}
  const compare = (a, b) => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => Object.is(v, b[i])) : Object.is(a, b)
  let flushing = false
  const flush = (sync = false) => {
    if (flushing) return
    flushing = true
    try {for (const w of watches) {if (sync && w.opts?.flush !== 'sync') continue; const value = w.get(); if (!compare(value, w.before)) {const old = w.before; w.before = value; w.fn(value, old)}}}
    finally {flushing = false}
  }
  const reactive = value => new Proxy(value, {set(target, key, next) {target[key] = next; flush(true); return true}})
  const refs = []
  const vue = {reactive, ref(value) {const ref = {value}; refs.push(ref); return ref},
    computed: get => ({get value() {return get()}}),
    watch(get, fn, opts) {watches.push({get, fn, opts, before: get()})},
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn)}
  const prefs = reactive({tool: options.tool ?? 'pan', size: options.size ?? 1, round: false, filled: false,
    primary: 0x123456, secondary: 0x654321, opacity: 1, density: 1, tolerance: 0,
    grid: false, showDraft: true, mirrorX: false, mirrorY: false})
  const board = reactive({status: options.initialStatus ?? 'ready', width, height, historyLoading: false, historyFrom: 0, clearedAt: null})
  const endpoint = reactive({rpc: 'a', chainId: 1, contract: '0x' + '1'.repeat(40), canvas: {}, router: null, deployBlock: 0})
  const chain = reactive({head: 10, interval: 15})
  const on = key => fn => {listeners[key].add(fn); return () => listeners[key].delete(fn)}
  const currentDraft = () => {if (!drafts.has(scope)) drafts.set(scope, new Map()); return drafts.get(scope)}
  const draft = {draftSurface: canvas(), pendingSurface: canvas(), pending: {size: 0}, draftState: {},
    onLayers: on('layers'), seen: i => currentDraft().get(i) ?? options.background?.(i) ?? 0xffffff,
    beginStroke() {strokes.push({kind: 'begin', scope})}, endStroke() {strokes.push({kind: 'end', scope})},
    put(x, y, rgb) {writes.push({scope, x, y, rgb}); currentDraft().set(y * width + x, rgb); return true},
    remove(x, y) {writes.push({scope, x, y, remove: true}); currentDraft().delete(y * width + x)}}
  const guide = reactive({picture: null, visible: false, opacity: 1, x: 0, y: 0})
  const stamp = {value: null}, usedColors = [], exposed = {}
  const math = Object.create(Math)
  math.random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32}
  const globals = {console, URL, URLSearchParams, document, window, location, history, Math: math,
    performance: {now: () => now}, getComputedStyle: () => ({getPropertyValue: () => ''}),
    ResizeObserver: class {observe() {} disconnect() {}}, MutationObserver: class {observe() {} disconnect() {}},
    setTimeout: window.setTimeout, setInterval: window.setInterval,
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    requestAnimationFrame(fn) {const id = next++; raf.set(id, fn); return id}, cancelAnimationFrame: id => raf.delete(id),
    defineProps: () => ({bare: !!options.bare}), withDefaults: (props, defaults) => ({...defaults, ...props}),
    defineEmits: () => () => {}, defineExpose(value) {Object.assign(exposed, value)}}
  const context = createContext(globals)
  const modules = new Map()
  const synthetic = (name, value) => {
    if (!modules.has(name)) modules.set(name, new SyntheticModule(Object.keys(value), function () {for (const [key, item] of Object.entries(value)) this.setExport(key, item)}, {context, identifier: name}))
    return modules.get(name)
  }
  const ports = {
    vue,
    '../core/board': {board, W: width, H: height, surface: canvas(), paints: {value: []},
      colorAt: i => options.background?.(i) ?? 0xffffff, whoPainted: () => null, onChanged: on('changed'), onAttributionChanged: on('attribution'), onArrived: on('arrived')},
    '../core/draft': draft,
    '../core/prefs': {prefs, axis: {x: 500, y: 500}, used: color => usedColors.push(color), putDown() {}},
    '../core/image': {guide, stamp, isImage: () => false, pixelsOf: () => []},
    '../core/chain': {chain}, '../core/format': {same: (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()},
    '../core/endpoint': {endpoint, explorerUrl: () => null}, '../core/wallet': {wallet: {address: null}}}
  const load = async url => {
    const key = String(url)
    if (modules.has(key)) return modules.get(key)
    const code = readFileSync(url, 'utf8')
    const module = new SourceTextModule(stripTypeScriptTypes(code, {mode: 'strip'}), {context, identifier: key})
    modules.set(key, module); return module
  }
  const link = async (name, parent) => {
    if (ports[name]) return synthetic(name, ports[name])
    if (name.endsWith('.vue')) return synthetic(name, {default: {}})
    if (name === '../core/tools') return load(new URL('core/tools.ts', base))
    if (name === '../core/color') return load(new URL('core/color.ts', base))
    if (name === './color') return load(new URL('color.ts', parent.identifier))
    throw new Error('Undeclared view capability: ' + name)
  }
  const tail = `\nexport const __handlers = {${Object.entries(handlers).map(([key, value]) => JSON.stringify(key) + ':' + value).join(',')}};
export function __attach(a,b,c) {host.value=a;cv.value=b;mini.value=c}
export function __state() {return {mode,panning,space,start,last,strokeEnd,preview:!!preview,region:region.length,pointers:pointers.size,pinch:!!pinch,fresh:fresh.length,located:!!located,glide:!!glide,hover,picked:picked.value,view:[scale,ox,oy],previewFrame,urlTimer,miniTimer}}
`
  const module = new SourceTextModule(stripTypeScriptTypes(script + tail, {mode: 'strip'}), {context, identifier: String(new URL('components/Board.vue', base))})
  await module.link(link); await module.evaluate()
  const host = {getBoundingClientRect: () => ({width: 800, height: 600})}, cv = canvas(), mini = canvas()
  module.namespace.__attach(host, cv, mini); mounted.forEach(fn => fn())
  const dispatch = (type, values = {}) => {
    const fn = module.namespace.__handlers[type]
    if (!fn) return false
    fn({type, pointerId: 1, clientX: 400, clientY: 300, button: 0, buttons: 1,
      shiftKey: false, altKey: false, ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 0,
      preventDefault() {}, ...values})
    flush(); return true
  }
  return {dispatch, prefs, board, endpoint, chain, writes, strokes, timers, raf, captures, history, location, exposed, usedColors,
    state: () => JSON.parse(JSON.stringify(module.namespace.__state())),
    screen(x, y) {const [s, ox, oy] = module.namespace.__state().view; return {clientX: ox + (x + 0.5) * s, clientY: oy + (y + 0.5) * s}},
    flush,
    frame() {const batch = [...raf]; raf.clear(); now += 16; batch.forEach(([, fn]) => fn(now)); frames.push(batch.length)},
    setContext(key, dimensions) {
      scope = key; endpoint.rpc = key; board.status = 'loading'; flush()
      if (dimensions) {
        [width, height] = dimensions
        modules.get('../core/board').setExport('W', width); modules.get('../core/board').setExport('H', height)
        board.width = width; board.height = height
      }
      board.status = 'ready'; flush()
    },
    arrive(p) {listeners.arrived.forEach(fn => fn([p]))},
    emitWindow(type, value = {}) {windowEvents.get(type)?.forEach(fn => fn({type, ...value})); flush()},
    visibility(value) {document.visibilityState = value; documentEvents.get('visibilitychange')?.forEach(fn => fn({type: 'visibilitychange'})); flush()},
    unmount() {unmounted.forEach(fn => fn()); module.namespace.__attach(null, null, null)},
    drainTimeouts() {for (const [id, timer] of [...timers]) if (!timer.interval) {timers.delete(id); timer.fn()}},
    templateHandlers: handlers,
    capabilityScope: 'Actual shipped SFC script and real tool/color modules; controlled memory-only Vue/compiler macros, canvas, clock, input and data ports. No Vue compilation, browser, IndexedDB, wallet or network execution.'}
}
