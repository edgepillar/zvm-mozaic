// Actual production modules; these ports do not qualify a browser or disk.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'
const baseline = process.env.MOZAIC_DRAFT_ORIGINAL === '1'
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40)
const key = (chain = 1, address = A) => `draft.${chain}.${address.toLowerCase()}`
const tick = async () => {for (let i = 0; i < 30; i++) await Promise.resolve()}
const bytes = rows => Uint8Array.from(rows.flatMap(([i, c]) => [i >> 16, i >> 8 & 255, i & 255, c >> 16, c >> 8 & 255, c & 255]))
const entries = data => {const out = []; for (let o = 0; o + 6 <= data.length; o += 6) out.push([(data[o]<<16)|(data[o+1]<<8)|data[o+2], (data[o+3]<<16)|(data[o+4]<<8)|data[o+5]]); return out}
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}

async function fixture({autoPut = true} = {}) {
  let track = null, now = 0, next = 0, W = 10, H = 10, boardModule
  const watches = [], queued = new Set(), frames = new Map(), timers = new Map(), reads = [], writes = [], saved = new Map(), legacy = new Map(), toasts = []
  const reactive = value => new Proxy(value, {
    get(target, name) {if (track) track.push([target, name]); return target[name]},
    set(target, name, value) {if (Object.is(target[name], value)) return true; target[name] = value
      for (const w of [...watches]) if (w.deps.some(([t, n]) => t === target && n === name)) {
        if (w.options?.flush === 'sync') invoke(w); else queued.add(w)
      }
      return true},
  })
  const read = w => {track = []; const value = w.get(); w.deps = track; track = null; return value}
  const invoke = w => {const old = w.value, value = read(w); w.value = value; if (!Object.is(value, old)) w.callback(value, old)}
  const watch = (get, callback, options) => {const w = {get, callback, options, deps: []}; w.value = read(w); watches.push(w)}
  const board = reactive({status: 'idle', syncedTo: 0, width: 0, height: 0})
  const endpoint = reactive({rpc: 'http://alpha.invalid/rpc', chainId: 1, contract: A, canvas: {width: W, height: H}})
  const context = createContext({Uint8Array, Uint32Array, Uint8ClampedArray, Int32Array,
    document: {createElement(tag) {assert.equal(tag, 'canvas'); return {width: 0, height: 0, getContext: () => ({putImageData() {}})}}},
    ImageData: class {constructor(w, h) {this.data = new Uint8ClampedArray(w*h*4); this.width = w; this.height = h}},
    requestAnimationFrame(fn) {const id = ++next; frames.set(id, fn); return id},
    clearTimeout(id) {timers.delete(id)}, window: {setTimeout(fn, delay) {const id = ++next; timers.set(id, {at: now + delay, fn}); return id}},
    localStorage: {getItem: k => legacy.get(k) ?? null, removeItem: k => legacy.delete(k)},
  })
  const ports = {
    vue: {reactive, watch}, './board': {board, colorAt: () => 0xffffff, onChanged: () => () => {}, W, H},
    './endpoint': {endpoint}, './toast': {toast: (...args) => toasts.push(args)},
    './idb': {get(k) {const d = deferred(); reads.push({key: k, ...d}); return d.promise},
      put(k, data) {const d = deferred(), row = {key: k, bytes: Uint8Array.from(data), ...d}; writes.push(row)
        if (autoPut) {saved.set(k, row.bytes); row.resolve()}; return row.promise}},
  }
  const linked = new Map()
  const module = new SourceTextModule(stripTypeScriptTypes(readFileSync(new URL('../src/core/draft.ts', import.meta.url), 'utf8'), {mode: 'strip'}), {context})
  await module.link(name => {
    assert.ok(ports[name], 'Only declared ports may be linked: ' + name)
    if (!linked.has(name)) {const data = ports[name]; linked.set(name, new SyntheticModule(Object.keys(data), function() {for (const [k, v] of Object.entries(data)) this.setExport(k, v)}, {context}))}
    if (name === './board') boardModule = linked.get(name)
    return linked.get(name)
  }); await module.evaluate({timeout: 5000})
  const api = module.namespace
  const flush = async () => {for (let n = 0; queued.size; n++) {assert.ok(n < 50); const batch = [...queued]; queued.clear(); for (const w of batch) invoke(w)}; await tick()}
  const frame = async () => {await flush(); for (let n = 0; frames.size; n++) {assert.ok(n < 20); const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(now); await flush()}}
  const advance = async milliseconds => {now += milliseconds; for (let n = 0; ; n++) {assert.ok(n < 100); const ready = [...timers].filter(([, row]) => row.at <= now); if (!ready.length) break
    for (const [id, row] of ready) {timers.delete(id); row.fn()}; await tick()}}
  const transition = async ({chain = 1, address = A, rpc = 'http://alpha.invalid/rpc', width = 10, height = 10} = {}) => {
    endpoint.rpc = rpc; endpoint.chainId = chain; endpoint.contract = address; endpoint.canvas = {width, height}
    board.status = 'loading'; W = width; H = height; boardModule.setExport('W', W); boardModule.setExport('H', H); board.width = W; board.height = H
    await flush(); board.status = 'ready'; await flush()
  }
  const answer = async (row, data = null) => {assert.ok(row); row.resolve(data); await tick()}
  const draw = (i, c = 0x112233) => {api.beginStroke(); api.put(i % W, Math.floor(i / W), c); api.endStroke()}
  const loaded = async (values = {}) => {await transition(values); await answer(reads.at(-1)); await frame()}
  return {api, board, endpoint, reads, writes, legacy, saved, toasts, timers, frames, transition, answer, draw, loaded, flush, frame, advance,
    async failRead(row) {row.reject(new Error('Controlled read failure')); await tick()},
    async commit(row) {saved.set(row.key, row.bytes); row.resolve(); await tick()},
    async abort(row) {row.reject(new Error('Controlled transaction abort')); await tick()},
    outgoing: () => Array.from(api.outgoing(), p => [p.index, p.rgb]),
  }
}

async function idbFixture() {
  const transactions = [], opening = {}, context = createContext({indexedDB: {open(name, version) {assert.equal(name, 'mozaic'); assert.equal(version, 1); return opening}}})
  const db = {transaction(name, mode) {assert.equal(name, 'kv'); const req = {}, row = {mode, req, error: null,
    objectStore: () => ({get: k => {row.key = k; return req}, put: (v, k) => {row.key = k; row.value = v; return req}, delete: k => {row.key = k; row.deleted = true; return req}})}
    transactions.push(row); return row}}
  const m = new SourceTextModule(stripTypeScriptTypes(readFileSync(new URL('../src/core/idb.ts', import.meta.url), 'utf8'), {mode: 'strip'}), {context})
  await m.link(() => assert.fail('IndexedDB module has no imports')); await m.evaluate({timeout: 5000})
  const open = async () => {opening.result = db; opening.onsuccess(); await tick()}
  const success = async (t, value) => {t.req.result = value; t.req.onsuccess(); await tick()}
  const commit = async t => {t.oncomplete?.(); await tick()}
  return {api: m.namespace, transactions, open, success, commit}
}

async function oldRestore() {
  const f = await fixture(); await f.transition(); const old = f.reads[0]
  await f.transition({chain: 2, address: B, rpc: 'http://beta.invalid/rpc'}); await f.answer(f.reads.at(-1)); await f.frame()
  await f.answer(old, bytes([[1, 0xff0000]])); await f.frame(); return f
}
async function oldTimer() {
  const f = await fixture(); await f.loaded(); f.draw(1, 0xff0000); await f.frame(); await f.advance(1100)
  await f.transition({chain: 2, address: B, rpc: 'http://beta.invalid/rpc'}); await f.answer(f.reads.at(-1)); f.draw(2, 0x0000ff)
  await f.advance(2000); return f
}
async function legacyBeforeAck() {
  const f = await fixture({autoPut: false}); f.legacy.set('mozaic.' + key(), Buffer.from(bytes([[1, 0x112233]])).toString('hex'))
  await f.loaded(); return f
}
async function requestBeforeCommit() {
  const f = await idbFixture(); let fulfilled = false
  const pending = f.api.put(key(), bytes([[1, 0x112233]])).then(() => {fulfilled = true})
  await f.open(); const t = f.transactions[0]; await f.success(t); return {f, t, pending, fulfilled: () => fulfilled}
}

if (baseline) {
  test('original late restore writes A pixels into the current B draft', async () => {const f = await oldRestore(); assert.deepEqual(f.outgoing(), [[1, 0xff0000]])})
  test('original A save timer writes the current B layer under A key', async () => {const f = await oldTimer(); assert.deepEqual(entries(f.saved.get(key())), [[2, 0x0000ff]])})
  test('original legacy data is removed before any durable write', async () => {const f = await legacyBeforeAck(); assert.equal(f.legacy.has('mozaic.' + key()), false); assert.equal(f.writes.length, 0)})
  test('original IndexedDB promise fulfills before transaction completion', async () => {const r = await requestBeforeCommit(); assert.equal(r.fulfilled(), true); await r.pending})
} else {
  test('old storage replies cannot populate another canvas or publish a stale toast', async () => {const f = await oldRestore(); assert.deepEqual(f.outgoing(), []); assert.equal(f.toasts.length, 0)})
  test('a retired timer encodes only its captured partition arrays', async () => {const f = await oldTimer(); assert.deepEqual(entries(f.saved.get(key())), [[1, 0xff0000]]); assert.deepEqual(f.outgoing(), [[2, 0x0000ff]])})
  test('unsaved A pixels survive a fast A B A transition', async () => {
    const f = await fixture(); await f.loaded(); f.draw(1); await f.frame(); await f.transition({chain: 2, address: B}); await f.answer(f.reads.at(-1)); await f.frame()
    await f.transition(); await f.frame(); assert.deepEqual(f.outgoing(), [[1, 0x112233]]); assert.equal(f.reads.filter(r => r.key === key()).length, 1)
  })
  test('same-partition RPC changes retain current unsaved pixels', async () => {const f = await fixture(); await f.loaded(); f.draw(3); await f.transition({rpc: 'http://other.invalid/rpc'}); await f.frame(); assert.deepEqual(f.outgoing(), [[3, 0x112233]]); assert.equal(f.reads.length, 1)})
  test('an A B A return shares the original pending A read and retains A edits', async () => {
    const f = await fixture(); await f.transition(); const a = f.reads[0]; f.draw(3); await f.frame()
    await f.transition({chain: 2, address: B}); await f.answer(f.reads.at(-1)); await f.transition(); assert.equal(f.reads.length, 2)
    await f.answer(a, bytes([[4, 0x445566]])); await f.frame(); assert.deepEqual(f.outgoing(), [[3, 0x112233], [4, 0x445566]])
  })
  test('an obsolete read failure leaves the current partition and toast untouched', async () => {const f = await fixture(); await f.transition(); const a = f.reads[0]; await f.transition({chain: 2, address: B}); await f.answer(f.reads.at(-1)); f.draw(2); await f.failRead(a); await f.frame(); assert.deepEqual(f.outgoing(), [[2, 0x112233]]); assert.equal(f.toasts.length, 0)})
  test('local edits win over delayed saved colours while unrelated saved pixels return', async () => {const f = await fixture(); await f.transition(); f.draw(1, 0xaabbcc); await f.answer(f.reads[0], bytes([[1, 0xff0000], [2, 0x00ff00]])); await f.frame(); assert.deepEqual(f.outgoing(), [[1, 0xaabbcc], [2, 0x00ff00]])})
  test('an edit removed before restore is not resurrected by saved bytes', async () => {const f = await fixture(); await f.transition(); f.draw(1); f.api.remove(1, 0); await f.answer(f.reads[0], bytes([[1, 0xff0000], [2, 0x00ff00]])); await f.frame(); assert.deepEqual(f.outgoing(), [[2, 0x00ff00]])})
  test('undo and redo during pending restore preserve local intent', async () => {const f = await fixture(); await f.transition(); f.draw(1); f.api.undo(); await f.answer(f.reads[0], bytes([[1, 0xff0000], [2, 0x00ff00]])); await f.frame(); assert.deepEqual(f.outgoing(), [[2, 0x00ff00]]); f.api.redo(); await f.frame(); assert.deepEqual(f.outgoing(), [[1, 0x112233], [2, 0x00ff00]])})
  test('an inactive read merges and saves only its own local edits', async () => {
    const f = await fixture(); await f.transition(); const a = f.reads[0]; f.draw(1); await f.frame(); await f.transition({chain: 2, address: B}); await f.answer(f.reads.at(-1)); await f.frame()
    await f.answer(a, bytes([[2, 0x445566]])); await f.advance(1200); assert.deepEqual(entries(f.saved.get(key())), [[1, 0x112233], [2, 0x445566]]); assert.deepEqual(f.outgoing(), [])
  })
  test('failed reads cannot overwrite unknown saved data and retry on reentry', async () => {
    const f = await fixture(); await f.transition(); f.draw(1); await f.failRead(f.reads[0]); await f.frame(); await f.advance(2000); assert.equal(f.writes.length, 0)
    await f.transition({rpc: 'http://retry.invalid/rpc'}); assert.equal(f.reads.length, 2); await f.answer(f.reads[1], bytes([[2, 0x445566]])); await f.frame(); assert.deepEqual(f.outgoing(), [[1, 0x112233], [2, 0x445566]])
  })
  test('failed writes retain the partition across node changes', async () => {
    const f = await fixture({autoPut: false}); await f.loaded(); f.draw(1); await f.frame(); await f.advance(1200); await f.abort(f.writes.at(-1))
    await f.transition({chain: 2, address: B}); await f.answer(f.reads.at(-1)); await f.transition(); await f.frame(); assert.deepEqual(f.outgoing(), [[1, 0x112233]])
  })
  test('same-key writes serialize and the last snapshot commits last', async () => {
    const f = await fixture({autoPut: false}); await f.loaded(); f.draw(1); await f.frame(); await f.advance(1200); assert.equal(f.writes.length, 1)
    f.draw(2); await f.frame(); await f.advance(1200); assert.equal(f.writes.length, 1); await f.commit(f.writes[0]); assert.equal(f.writes.length, 2)
    await f.commit(f.writes[1]); assert.deepEqual(entries(f.saved.get(key())), [[1, 0x112233], [2, 0x112233]])
  })
  test('different partitions retain independent debounced timers', async () => {
    const f = await fixture(); await f.loaded(); f.draw(1); await f.frame(); await f.transition({chain: 2, address: B}); await f.answer(f.reads.at(-1)); f.draw(2, 0x445566); await f.frame(); await f.advance(1200)
    assert.deepEqual(entries(f.saved.get(key())), [[1, 0x112233]]); assert.deepEqual(entries(f.saved.get(key(2, B))), [[2, 0x445566]])
  })
  test('timer encoding counts captured membership including edits before the next frame', async () => {const f = await fixture(); await f.loaded(); f.draw(1); await f.frame(); f.draw(2); await f.advance(1200); assert.deepEqual(entries(f.saved.get(key())), [[1, 0x112233], [2, 0x112233]])})
  test('legacy bytes survive until commit and survive a failed migration', async () => {const f = await legacyBeforeAck(); assert.ok(f.legacy.has('mozaic.' + key())); await f.advance(1200); await f.abort(f.writes[0]); assert.ok(f.legacy.has('mozaic.' + key())); await f.transition({rpc: 'http://retry.invalid/rpc'}); await f.frame(); await f.advance(1200); await f.commit(f.writes.at(-1)); assert.equal(f.legacy.has('mozaic.' + key()), false)})
  test('legacy cleanup cannot remove a newer value written by another tab', async () => {const f = await legacyBeforeAck(); await f.advance(1200); f.legacy.set('mozaic.' + key(), '112233445566'); await f.commit(f.writes[0]); assert.equal(f.legacy.get('mozaic.' + key()), '112233445566')})
  test('malformed saved values remain unread and cannot be overwritten', async () => {for (const value of [new Uint8Array([1]), {arbitrary: true}]) {const f = await fixture(); await f.transition(); f.draw(1); await f.answer(f.reads[0], value); await f.frame(); await f.advance(2000); assert.equal(f.writes.length, 0); assert.deepEqual(f.outgoing(), [[1, 0x112233]])}})
  test('malformed legacy bytes remain untouched', async () => {const f = await fixture(); f.legacy.set('mozaic.' + key(), 'not-valid-hex'); await f.loaded(); await f.advance(1200); assert.equal(f.legacy.get('mozaic.' + key()), 'not-valid-hex')})
  test('clearing a draft writes an empty value only under its own key', async () => {const f = await fixture(); await f.loaded(); f.draw(1); await f.frame(); await f.advance(1200); f.api.clearDraft(); await f.frame(); await f.advance(1200); assert.equal(f.writes.at(-1).key, key()); assert.equal(f.writes.at(-1).bytes.length, 0)})
  test('saved indices and cached layers obey the current canvas bounds', async () => {const f = await fixture(); await f.transition({width: 2, height: 2}); await f.answer(f.reads[0], bytes([[0, 0x112233], [4, 0xaabbcc]])); await f.frame(); assert.deepEqual(f.outgoing(), [[0, 0x112233]]); f.draw(3); await f.transition({rpc: 'http://smaller.invalid/rpc', width: 1, height: 1}); await f.frame(); assert.deepEqual(f.outgoing(), [[0, 0x112233]])})
  test('IndexedDB request success waits for transaction completion', async () => {const r = await requestBeforeCommit(); assert.equal(r.fulfilled(), false); await r.f.commit(r.t); await r.pending; assert.equal(r.fulfilled(), true)})
  test('IndexedDB abort after request success rejects the write', async () => {const f = await idbFixture(); const p = f.api.put(key(), bytes([[1, 0x112233]])); const rejected = assert.rejects(p, /aborted/); await f.open(); const t = f.transactions[0]; await f.success(t); t.onabort(); await rejected})
  test('IndexedDB request failures reject without a success claim', async () => {const f = await idbFixture(); const p = f.api.put(key(), bytes([])), rejected = assert.rejects(p, /request failed/); await f.open(); const t = f.transactions[0]; t.req.error = new Error('request failed'); t.req.onerror(); await rejected})
  test('IndexedDB reads return the captured value only after commit', async () => {const f = await idbFixture(); let settled = false; const value = bytes([[1, 0x112233]]), p = f.api.get(key()).then(v => {settled = true; return v}); await f.open(); const t = f.transactions[0]; await f.success(t, value); assert.equal(settled, false); await f.commit(t); assert.equal(await p, value); assert.equal(t.mode, 'readonly')})
}
