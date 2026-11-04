// Execute shipped board, codec and ops modules with declared memory ports.
// Browser, ABI transport and production entry are qualified separately in CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), R = '0x' + '3'.repeat(40), ARTIST = '0x' + '4'.repeat(40)
const alpha = 'http://alpha.invalid/rpc', beta = 'http://beta.invalid/rpc'
const TOPIC = {paint: '0x' + 'a'.repeat(64), by: '0x' + 'b'.repeat(64), clear: '0x' + 'c'.repeat(64)}
const TX = '0x' + 'd'.repeat(64), hex = value => '0x' + Number(value).toString(16)
const settle = async () => {for (let i = 0; i < 24; i++) await Promise.resolve()}
const pixels = (list) => list.map(({index, rgb}) => index.toString(16).padStart(6, '0') + rgb.toString(16).padStart(6, '0')).join('')
const word = value => BigInt(value).toString(16).padStart(64, '0')
const addressTopic = address => '0x' + address.slice(2).padStart(64, '0')
const painted = (block, list, sender = ARTIST, tx = TX) => ({blockNumber: hex(block), transactionHash: tx,
  topics: [TOPIC.paint, addressTopic(sender)], data: '0x' + word(list.length) + word(64) + word(list.length * 6) + pixels(list)})
const credited = (block, artist = ARTIST) => ({blockNumber: hex(block), transactionHash: TX,
  topics: [TOPIC.by, addressTopic(artist)], data: '0x'})
const cleared = block => ({blockNumber: hex(block), transactionHash: TX, topics: [TOPIC.clear], data: '0x'})
function chunk(list = []) {
  const slots = new Map()
  for (const {index, rgb} of list) {const slot = Math.floor(index / 10), shift = BigInt(index % 10) * 24n
    slots.set(slot, (slots.get(slot) ?? 0n) | (BigInt(rgb ^ 0xffffff) << shift))}
  return '0x' + Array.from(slots).sort((a, b) => a[0] - b[0]).map(([slot, value]) => slot.toString(16).padStart(8, '0') + word(value)).join('')
}

async function fixture(options = {}) {
  const requests = [], watches = [], beats = [], surfaces = [], draws = []
  let clock = 100_000, onState = null, onFetch = null
  const endpoint = {rpc: alpha, chainId: 1, contract: A, router: null, deployBlock: null, health: 'ok',
    canvas: {width: options.width ?? 10, height: options.height ?? 10, price: 1n, owner: ARTIST}}
  const canvas = () => {
    const value = {width: 0, height: 0, getContext: () => ({putImageData(image) {draws.push({image, width: value.width, height: value.height})}, drawImage() {}}),
      toBlob(callback) {callback({memoryOnly: true})}}
    surfaces.push(value); return value
  }
  const context = createContext({document: {createElement: tag => {assert.equal(tag, 'canvas'); return canvas()}},
    ImageData: class {constructor(data, width, height) {this.data = data; this.width = width; this.height = height}},
    Date: {now: () => clock}, AbortSignal: {timeout: milliseconds => ({milliseconds})},
    fetch(url, values) {
      let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no})
      const body = JSON.parse(values.body), call = body.method === 'eth_call' ? JSON.parse(body.params[0].data) : null
      const kind = body.method === 'eth_blockNumber' ? 'head' : body.method === 'eth_getLogs' ? 'logs' :
        body.method === 'eth_getBalance' ? 'balance' : call.functionName
      const row = {url, values, body, call, kind, resolve, reject, answered: false}; requests.push(row)
      if (onFetch) onFetch(row); return promise
    }})
  const dependencies = {
    vue: {reactive: value => new Proxy(value, {set(target, key, next) {const changed = !Object.is(target[key], next)
      target[key] = next; if (changed && onState) onState(key, next); return true}}),
      shallowRef: value => ({value}), watch: (get, callback, options) => watches.push({get, callback, options})},
    './endpoint': {endpoint, ready: {get value() {return endpoint.health === 'ok' && !!endpoint.canvas}}},
    './chain': {onBlock: callback => {beats.push(callback); return () => {}}},
    './abi': {MOZAIC_ABI: 'canvas-ABI-port'},
    viem: {encodeFunctionData: value => {assert.equal(value.abi, 'canvas-ABI-port'); return JSON.stringify({functionName: value.functionName, args: (value.args ?? []).map(String)})},
      decodeFunctionResult: value => {assert.equal(value.abi, 'canvas-ABI-port'); assert.equal(value.functionName, 'chunk'); return value.data},
      toBytes: value => value, keccak256: value => value.startsWith('PaintedBy') ? TOPIC.by : value.startsWith('Painted(') ? TOPIC.paint : TOPIC.clear},
  }
  const modules = new Map()
  const get = name => {
    if (modules.has(name)) return modules.get(name)
    let module
    if (name === './board' || name === './codec' || name === './ops') {
      const source = readFileSync(new URL('../src/core/' + name.slice(2) + '.ts', import.meta.url), 'utf8')
      module = new SourceTextModule(stripTypeScriptTypes(source, {mode: 'strip'}) + (name === './board' ? '\nexport {refreshTotals};' : ''), {context})
    } else {
      const values = dependencies[name]; assert.ok(values, 'Only declared capabilities may be linked: ' + name)
      module = new SyntheticModule(Object.keys(values), function() {for (const [key, value] of Object.entries(values)) this.setExport(key, value)}, {context})
    }
    modules.set(name, module); return module
  }
  const module = get('./board'); await module.link(name => get(name)); await module.evaluate({timeout: 5000})
  const api = module.namespace, pending = (kind, url = endpoint.rpc) => requests.filter(row => !row.answered && row.kind === kind && row.url === url)
  const reply = async (row, value, error = null, status = 200) => {
    assert.ok(row && !row.answered, 'Resolve only one actual pending memory request')
    row.answered = true; row.resolve({ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Unavailable',
      json: async () => error ? {error} : {result: value}}); await settle()
  }
  const snapshot = async (head = 10, list = []) => {
    const row = pending('head').at(-1); await reply(row, hex(head))
    let count = 0
    while (pending('chunk').length) {assert.ok(++count <= 20); await reply(pending('chunk')[0], chunk(list))}
    await settle()
  }
  const background = async ({head = 10, logs = [], painted = 2, balance = 3, totals = true, ignore = []} = {}) => {
    for (let i = 0; i < 30; i++) {
      const row = requests.find(row => !row.answered && !ignore.includes(row) && row.url === endpoint.rpc && row.kind !== 'chunk' && (totals || !['painted', 'balance'].includes(row.kind)))
      if (!row) return
      await reply(row, row.kind === 'head' ? hex(head) : row.kind === 'logs' ? (typeof logs === 'function' ? logs(row) : logs) : row.kind === 'painted' ? hex(painted) : hex(balance))
    }
    assert.fail('A bounded memory background drain must finish')
  }
  const change = values => {
    const copy = get => {const value = get(); return Array.isArray(value) ? Array.from(value) : value}
    const before = watches.map(row => copy(row.get)); Object.assign(endpoint, values)
    return watches.map((row, i) => {const next = copy(row.get), old = before[i]
      const changed = Array.isArray(next) ? next.some((value, k) => !Object.is(value, old[k])) : !Object.is(next, old)
      if (changed) return row.callback(next, old)
    })
  }
  return {api, endpoint, requests, watches, beats, surfaces, draws, pending, reply, snapshot, background, change,
    time(value) {clock = value}, observe(callback) {onState = callback}, reenter(callback) {onFetch = callback},
    beat(head) {for (const callback of beats) callback(head)},
    async reject(row) {assert.ok(row && !row.answered); row.answered = true; row.reject(new Error('Memory read failed')); await settle()},
    async loaded(options = {}) {const done = api.load(); await snapshot(options.head ?? 10, options.pixels ?? []); await done; await background(options)},
  }
}

test('snapshot retains original calls, progressive pixels and current metadata', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x123456}, {index: 99, rgb: 0xff8000}]})
  assert.equal(f.api.board.status, 'ready'); assert.equal(f.api.board.progress, 1); assert.equal(f.api.board.syncedTo, 10)
  assert.equal(f.api.colorAt(0), 0x123456); assert.equal(f.api.colorAt(99), 0xff8000); assert.equal(f.api.colorAt(1), 0xffffff)
  assert.equal(f.api.board.painted, 2n); assert.equal(f.api.board.balance, 3n); assert.equal(f.api.board.historyFrom, 0)
  assert.ok(f.requests.every(row => row.url === alpha && row.values.signal.milliseconds === 60_000))
  const read = f.requests.find(row => row.kind === 'chunk'); assert.deepEqual(read.call.args, ['0', '10000'])
  assert.equal(read.body.params[0].to, A); assert.equal(read.body.params[1], 'latest')
})
test('the million-pixel snapshot retains ten original calls and three concurrent workers', async () => {
  const f = await fixture({width: 1000, height: 1000}), done = f.api.load(); await f.reply(f.pending('head')[0], hex(10))
  assert.deepEqual(f.pending('chunk').map(row => row.call.args[0]), ['0', '10000', '20000'])
  let completed = 0
  while (f.pending('chunk').length) {assert.ok(f.pending('chunk').length <= 3); await f.reply(f.pending('chunk')[0], chunk()); completed++}
  await done; assert.equal(completed, 10); assert.equal(f.api.W, 1000); assert.equal(f.api.H, 1000); assert.equal(f.api.board.progress, 1)
  await f.background()
})
test('current load calls and synchronous fetch reentry share one complete snapshot', async () => {
  const f = await fixture(); let nested; f.reenter(row => {if (row.kind === 'head') nested = f.api.load()})
  const done = f.api.load(); assert.equal(nested, done); for (let i = 0; i < 100; i++) assert.equal(f.api.load(), done)
  assert.equal(f.requests.length, 1); f.reenter(null); await f.snapshot(); await done; await f.background()
})
test('a delayed old head starts no snapshot calls against the newly selected RPC', async () => {
  const f = await fixture(), old = f.api.load(), first = f.requests[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}})
  await f.reply(first, hex(10)); await old; assert.equal(f.requests.length, 2)
  await f.snapshot(20); await f.background({head: 20}); assert.equal(f.api.board.syncedTo, 20)
  assert.ok(f.requests.filter(row => row.url === beta && row.kind === 'chunk').every(row => row.body.params[0].to === B))
})
test('old snapshot chunks cannot recolor a new canvas or replace its progress', async () => {
  const f = await fixture(), old = f.api.load(); await f.reply(f.pending('head')[0], hex(10)); const held = f.pending('chunk')[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}})
  await f.snapshot(20, [{index: 0, rgb: 0x112233}]); await f.background({head: 20})
  await f.reply(held, chunk([{index: 0, rgb: 0xff0000}])); await old
  assert.equal(f.api.colorAt(0), 0x112233); assert.equal(f.api.board.syncedTo, 20); assert.equal(f.api.board.progress, 1)
})
test('old snapshot failures cannot replace a newer ready board', async () => {
  const f = await fixture(), old = f.api.load(), held = f.requests[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20); await f.background({head: 20})
  await f.reject(held); await old; assert.equal(f.api.board.status, 'ready'); assert.equal(f.api.board.error, null)
})
test('same-RPC chain changes synchronously invalidate snapshot ownership', async () => {
  const f = await fixture(), old = f.api.load(), held = f.requests[0]; f.change({chainId: 2})
  await f.reply(held, hex(10)); await old; assert.equal(f.requests.length, 2); assert.equal(f.api.board.syncedTo, 0)
  assert.equal(f.watches[0].options.flush, 'sync'); await f.snapshot(20); await f.background({head: 20})
})
test('health loss clears old decoration, history and canvas pixels without changing layer dimensions', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x123456}], logs: [painted(5, [{index: 0, rgb: 0x123456}])]})
  f.change({health: 'checking'}); assert.equal(f.api.board.status, 'idle'); assert.equal(f.api.board.painted, null)
  assert.equal(f.api.board.balance, null); assert.equal(f.api.board.historyFrom, null); assert.equal(f.api.paints.value.length, 0)
  assert.equal(f.api.colorAt(0), 0xffffff); assert.equal(f.api.whoPainted(0), null); assert.equal(f.api.W, 10); assert.equal(f.api.H, 10)
})
test('a failed current snapshot stays visible and a later load recovers', async () => {
  const f = await fixture(), done = f.api.load(); await f.reject(f.requests[0]); await done
  assert.equal(f.api.board.status, 'error'); assert.equal(f.api.board.error, 'Memory read failed'); await f.loaded(); assert.equal(f.api.board.error, null)
})
test('late old totals cannot overwrite the new canvas counters or balance', async () => {
  const f = await fixture(); const first = f.api.load(); await f.snapshot(); await first
  const oldPainted = f.pending('painted')[0], oldBalance = f.pending('balance')[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20); await f.background({head: 20, painted: 7, balance: 8})
  await f.reply(oldPainted, hex(41)); await f.reply(oldBalance, hex(42))
  assert.equal(f.api.board.painted, 7n); assert.equal(f.api.board.balance, 8n)
})
test('current totals coalesce forced reads and preserve the original minute cooldown', async () => {
  const f = await fixture(); await f.loaded(); const start = f.requests.length
  f.time(159_999); await f.api.refreshTotals(); assert.equal(f.requests.length, start)
  f.time(160_000); const pending = f.api.refreshTotals()
  for (let i = 0; i < 100; i++) assert.equal(f.api.refreshTotals(true), pending)
  assert.equal(f.requests.length, start + 2); await f.reply(f.pending('painted')[0], hex(9)); await f.reply(f.pending('balance')[0], hex(10)); await pending
  assert.equal(f.api.board.painted, 9n); assert.equal(f.api.board.balance, 10n)
})
test('new context totals start immediately during the previous context cooldown', async () => {
  const f = await fixture(); await f.loaded(); f.time(100_001)
  f.change({contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20); assert.equal(f.pending('painted').length, 1)
  assert.equal(f.pending('balance').length, 1); await f.background({head: 20})
})
test('an old totals finally cannot release a new pending counter read', async () => {
  const f = await fixture(); const initial = f.api.load(); await f.snapshot(); await initial
  const p = f.pending('painted')[0], b = f.pending('balance')[0]; f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}})
  await f.snapshot(20); const current = f.api.refreshTotals(true)
  await f.reply(p, hex(1)); await f.reply(b, hex(1)); assert.equal(f.api.refreshTotals(true), current)
  await f.background({head: 20}); await current
})
test('history keeps the original deployment floor, day window and five-thousand-block spans', async () => {
  const f = await fixture(); f.endpoint.deployBlock = 100; const done = f.api.load(); await f.snapshot(12_000); await done
  const first = f.pending('logs')[0]; assert.equal(first.body.params[0].fromBlock, hex(6240)); assert.equal(first.body.params[0].toBlock, hex(11239))
  await f.reply(first, []); const second = f.pending('logs')[0]; assert.equal(second.body.params[0].fromBlock, hex(11240)); assert.equal(second.body.params[0].toBlock, hex(12000))
  await f.reply(second, []); await f.background({head: 12000}); assert.equal(f.api.board.historyFrom, 6240)
})
test('late history cannot replace a new context paint list or loading flag', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const held = f.pending('logs')[0]
  f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20)
  assert.equal(f.api.board.historyLoading, true); await f.reply(held, [painted(5, [{index: 0, rgb: 0xff0000}])])
  assert.equal(f.api.board.historyLoading, true); assert.equal(f.api.paints.value.length, 0); await f.background({head: 20})
})
test('a rejected obsolete log range starts no recursive retries on the new RPC', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const held = f.pending('logs')[0]
  f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}}); const count = f.requests.length
  await f.reply(held, null, {message: 'range too large'}); assert.equal(f.requests.length, count)
  await f.snapshot(20); await f.background({head: 20})
})
test('current rejected log ranges retain recursive lower-then-upper splitting and order', async () => {
  const f = await fixture(); await f.loaded(); const done = f.api.sync(14), first = f.pending('logs')[0]
  assert.equal(first.body.params[0].fromBlock, hex(11)); assert.equal(first.body.params[0].toBlock, hex(14))
  await f.reply(first, null, {message: 'range too large'}); const lower = f.pending('logs')[0]
  assert.equal(lower.body.params[0].fromBlock, hex(11)); assert.equal(lower.body.params[0].toBlock, hex(12)); await f.reply(lower, [painted(12, [{index: 0, rgb: 0x112233}])])
  const upper = f.pending('logs')[0]; assert.equal(upper.body.params[0].fromBlock, hex(13)); assert.equal(upper.body.params[0].toBlock, hex(14))
  await f.reply(upper, [painted(14, [{index: 0, rgb: 0x445566}])]); await done
  assert.equal(f.api.colorAt(0), 0x445566); assert.equal(f.api.board.syncedTo, 14)
})
test('live sync uses the beat without an extra head request and preserves complete event order', async () => {
  const f = await fixture(); await f.loaded(); const count = f.requests.length, seen = []; f.api.onArrived(rows => seen.push(...rows.map(row => row.block)))
  const done = f.api.sync(12); assert.equal(f.requests.length, count + 1)
  await f.reply(f.pending('logs')[0], [painted(11, [{index: 0, rgb: 0x112233}]), painted(12, [{index: 0, rgb: 0x445566}])]); await done
  assert.equal(f.api.colorAt(0), 0x445566); assert.deepEqual(seen, [11, 12]); assert.equal(f.api.board.syncedTo, 12)
})
test('a new board sync proceeds while the previous canvas log read is still pending', async () => {
  const f = await fixture(); await f.loaded(); const old = f.api.sync(100), held = f.pending('logs')[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20)
  assert.equal(f.pending('head').length, 1); await f.background({head: 21})
  await f.reply(held, [painted(100, [{index: 0, rgb: 0xff0000}])]); await old
  assert.equal(f.api.board.syncedTo, 21); assert.equal(f.api.colorAt(0), 0xffffff)
})
test('a pending sync coalesces reentry and retains the newest current beat', async () => {
  const f = await fixture(); await f.loaded(); const done = f.api.sync(12)
  for (let i = 0; i < 100; i++) assert.equal(f.api.sync(14), done)
  await f.reply(f.pending('logs')[0], []); const next = f.pending('logs')[0]
  assert.equal(next.body.params[0].fromBlock, hex(13)); assert.equal(next.body.params[0].toBlock, hex(14)); await f.reply(next, []); await done
  assert.equal(f.api.board.syncedTo, 14)
})
test('a late old head hint cannot cause new-canvas reads through the old chain height', async () => {
  const f = await fixture(); await f.loaded(); const old = f.api.sync(100), held = f.pending('logs')[0]
  f.api.sync(110); f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}})
  await f.snapshot(20); await f.background({head: 20}); await f.reply(held, []); await old
  assert.ok(f.requests.filter(row => row.url === beta && row.kind === 'logs').every(row => parseInt(row.body.params[0].toBlock, 16) <= 20))
})
test('late router discovery refreshes attribution without restarting snapshot or board status', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x112233}], logs: [painted(5, [{index: 0, rgb: 0x112233}], R)]})
  const chunks = f.requests.filter(row => row.kind === 'chunk').length; assert.equal(f.api.whoPainted(0).painter, R)
  f.change({router: R}); assert.equal(f.api.board.status, 'ready'); await f.background({logs: [credited(5), painted(5, [{index: 0, rgb: 0xff0000}], R)]})
  assert.equal(f.requests.filter(row => row.kind === 'chunk').length, chunks); assert.equal(f.api.colorAt(0), 0x112233)
  assert.equal(f.api.whoPainted(0).painter, ARTIST); assert.ok(f.requests.filter(row => row.kind === 'logs').at(-1).body.params[0].address.includes(R))
})
test('a pending routerless history cannot overwrite the refreshed router attribution', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const old = f.pending('logs')[0]
  f.change({router: R}); await f.background({ignore: [old], logs: [credited(5), painted(5, [{index: 0, rgb: 0x112233}], R)]})
  await f.reply(old, [painted(5, [{index: 0, rgb: 0x112233}], R)]); assert.equal(f.api.whoPainted(0).painter, ARTIST)
})
test('history does not repaint pixels or replace a newer live painter', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const old = f.pending('logs')[0]
  await f.reply(f.pending('head')[0], hex(12)); const live = f.pending('logs').find(row => row !== old)
  await f.reply(live, [painted(12, [{index: 0, rgb: 0x112233}], ARTIST)]); await f.reply(old, [painted(5, [{index: 0, rgb: 0xff0000}], R)])
  assert.equal(f.api.colorAt(0), 0x112233); assert.equal(f.api.whoPainted(0).block, 12); assert.equal(f.api.paints.value.at(-1).block, 12)
  await f.background({head: 12})
})
test('clear events preserve the original white pixels and subsequent painter attribution', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x112233}]}); const done = f.api.sync(12)
  await f.reply(f.pending('logs')[0], [cleared(11), painted(12, [{index: 1, rgb: 0x445566}])]); await done
  assert.equal(f.api.colorAt(0), 0xffffff); assert.equal(f.api.colorAt(1), 0x445566); assert.equal(f.api.board.clearedAt, 11)
  assert.equal(f.api.whoPainted(0), null); assert.equal(f.api.whoPainted(1).block, 12)
})
test('a listener context change refuses later old-context notifications and cursor publication', async () => {
  const f = await fixture(); await f.loaded(); const seen = []
  let off; off = f.api.onChanged(() => {off(); f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}})})
  f.api.onArrived(() => seen.push('old')); const done = f.api.sync(12)
  // Remove the reentrant listener through its returned disposer before new allocation.
  // Only the first old-context flush should trigger the selection.
  await f.reply(f.pending('logs')[0], [painted(12, [{index: 0, rgb: 0x112233}])]); await done
  assert.deepEqual(seen, []); assert.equal(f.api.board.syncedTo, 0)
})
