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

export {A, B, R, ARTIST, alpha, beta, TOPIC, TX, hex, settle, pixels, word, addressTopic, painted, credited, cleared, chunk, fixture};
