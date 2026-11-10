// Serve the existing production build to real Chrome with controlled loopback
// RPC replies. No product modules are replaced and no wallet is connected.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile, stat} from 'node:fs/promises'
import {existsSync, readFileSync} from 'node:fs'
import {resolve, extname} from 'node:path'
import {createHash} from 'node:crypto'
import {crc32, deflateSync} from 'node:zlib'
import {execFileSync} from 'node:child_process'
import {stripTypeScriptTypes} from 'node:module'
import puppeteer from 'puppeteer-core'
import {decodeFunctionData, encodeFunctionResult, encodeAbiParameters, keccak256, toBytes} from 'viem'

const root = resolve('dist'), base = process.env.BASE_PATH ?? '/zvm-mozaic/'
assert.ok(base.startsWith('/') && base.endsWith('/'))
const source = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
assert.match(source, /^[0-9a-f]{40}$/)
const js = stripTypeScriptTypes(readFileSync('src/core/abi.ts', 'utf8'), {mode: 'strip'})
const {MOZAIC_ABI, ROUTER_ABI} = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), OTHER = '0x' + '5'.repeat(40), R = '0x' + '3'.repeat(40), ARTIST = '0x' + '4'.repeat(40)
const DETAIL_TX = '0x' + 'c'.repeat(64), DETAIL_INDEX = 500_500
const TX = '0x' + 'd'.repeat(64), hash = '0x' + 'e'.repeat(64), zero = '0x' + '0'.repeat(64)
const hex = value => '0x' + BigInt(value).toString(16)
const topic = value => keccak256(toBytes(value)), addressTopic = address => '0x' + address.slice(2).padStart(64, '0')
const px = '0x000000112233'
const canvasPaint = {address: A, blockNumber: '0x9', transactionHash: TX, transactionIndex: '0x0', logIndex: '0x1', blockHash: hash, removed: false,
  topics: [topic('Painted(address,uint256,bytes)'), addressTopic(R)], data: encodeAbiParameters([{type: 'uint256'}, {type: 'bytes'}], [1n, px])}
const routerPaint = {address: R, blockNumber: '0x9', transactionHash: TX, transactionIndex: '0x0', logIndex: '0x0', blockHash: hash, removed: false,
  topics: [topic('PaintedBy(address,address,uint256)'), addressTopic(ARTIST), addressTopic(ARTIST)], data: encodeAbiParameters([{type: 'uint256'}], [1n])}
const DETAIL_CASES = ['late-history-details','late-router-details','live-details','history-unavailable-details','unavailable-details']
const GESTURE_CASES = ["pointer-cancel", "held-pointer-context", "pinch-spray", "deferred-route", "view-dimensions"]
const IMAGE_CASES = ['image-stamp', 'image-close', 'image-replace-guide', 'image-close-pending', 'image-drop', 'image-alpha-count', 'image-stamp-overlap', 'image-tall-preview', 'image-paste-svg', 'image-source-budget', 'image-transfer-budget']
const MODAL_CASES = ['image-queued-close', 'image-native-escape', 'node-modal-queued-close', 'modal-focus-keyboard']
const NODE_RPC = 'dialog[open] [data-testid="node-rpc"]'
const NODE_CONTRACT = 'dialog[open] [data-testid="node-contract"]'
function detailPaint({block = 9, painter = ARTIST, transaction = TX, rgb = 0x112233} = {}) {
  const packed = '0x' + DETAIL_INDEX.toString(16).padStart(6, '0') + rgb.toString(16).padStart(6, '0')
  return {...canvasPaint, blockNumber: hex(block), transactionHash: transaction,
    topics: [canvasPaint.topics[0], addressTopic(painter)],
    data: encodeAbiParameters([{type: 'uint256'}, {type: 'bytes'}], [1n, packed])}
}
let active, origin
const delivered = new Map(), unexpected = [], errors = []
const encode = (abi, functionName, result) => encodeFunctionResult({abi, functionName, result})
const later = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(test, label) {const started = Date.now(); while (!test()) {assert.ok(Date.now() - started < 20_000, label); await later(20)}}
function hold(state, name, result) {
  assert.ok(!state.held.has(name), 'A controlled reply is held exactly once: ' + name)
  return new Promise(resolve => {state.held.set(name, {result, release(value = result) {assert.equal(this.released, undefined); this.released = true; resolve(value)}})})
}
async function rpc(state, node, call, batched) {
  state.calls.push({node, method: call.method, params: call.params, batched})
  const head = state.head ?? (node === 'a' ? 10 : 20)
  const second = node === 'b' || call.params?.[0]?.to?.toLowerCase() === B || call.params?.[0]?.toLowerCase?.() === B
  if (call.method === 'eth_chainId') return hex(node === 'a' ? 13370 : 13371)
  if (call.method === 'eth_blockNumber') {
    if (state.name === 'old-head' && node === 'a' && !batched && !state.held.has('head')) return hold(state, 'head', hex(head))
    return hex(head)
  }
  if (call.method === 'eth_getBlockByNumber') return {number: hex(head), timestamp: hex(head * 15), hash, parentHash: zero,
    nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', size: '0x0',
    miner: ARTIST, extraData: '0x', transactions: [], uncles: [], logsBloom: '0x' + '0'.repeat(512), sha3Uncles: zero,
    stateRoot: zero, transactionsRoot: zero, receiptsRoot: zero, mixHash: zero, baseFeePerGas: '0x7'}
  if (call.method === 'eth_getBalance') {
    const value = second ? hex(8n * 10n ** 18n) : hex(6n * 10n ** 18n)
    if (state.name === 'old-totals' && node === 'a' && !state.held.has('balance')) return hold(state, 'balance', value)
    return value
  }
  if (call.method === 'eth_call') {
    const router = call.params[0].to.toLowerCase() === R.toLowerCase(), abi = router ? ROUTER_ABI : MOZAIC_ABI
    const {functionName, args = []} = decodeFunctionData({abi, data: call.params[0].data})
    state.contractCalls.push({node, functionName, args: args.map(String), to: call.params[0].to})
    if (router) {
      assert.equal(functionName, 'canvas'); const value = encode(abi, functionName, A)
      if (['late-router', 'late-router-details'].includes(state.name) && node === 'a' && !state.held.has('router')) return hold(state, 'router', value)
      return value
    }
    if (functionName === 'WIDTH' || functionName === 'HEIGHT') return encode(abi, functionName, state.name === 'view-dimensions' && node === 'b' ? 40n : 1000n)
    if (functionName === 'price') return encode(abi, functionName, 100_000_000_000_000n)
    if (functionName === 'owner') return encode(abi, functionName, ARTIST)
    if (functionName === 'painted') {
      const value = encode(abi, functionName, second ? 7n : 5n)
      if (state.name === 'old-totals' && node === 'a' && !state.held.has('painted')) return hold(state, 'painted', value)
      return value
    }
    assert.equal(functionName, 'chunk')
    assert.equal(args[1], 10_000n)
    if (DETAIL_CASES.includes(state.name)) {
      const slot = Math.floor(DETAIL_INDEX / 10), value = args[0] === 50_000n ? '0x' + slot.toString(16).padStart(8, '0') + BigInt(0x112233 ^ 0xffffff).toString(16).padStart(64, '0') : '0x'
      return encode(abi, functionName, value)
    }
    const colour = ['old-chunk', 'canvas-switch'].includes(state.name) ? (second ? 0x446688 : 0xff0000) : 0x112233
    const value = args[0] === 0n ? '0x00000000' + (BigInt(colour ^ 0xffffff)).toString(16).padStart(64, '0') : '0x'
    const encoded = encode(abi, functionName, value)
    if (['old-chunk', 'canvas-switch'].includes(state.name) && !second && args[0] === 0n && !state.held.has('chunk')) return hold(state, 'chunk', encoded)
    return encoded
  }
  if (call.method === 'eth_getLogs') {
    if (['old-history', 'old-log-error'].includes(state.name) && node === 'a' && !state.held.has('history')) return hold(state, 'history', [canvasPaint])
    const filter = call.params[0], from = Number(filter.fromBlock), to = Number(filter.toBlock)
    if (['late-history-details','history-unavailable-details'].includes(state.name) && node === 'a' && !state.held.has('detail-history')) return hold(state, 'detail-history', [detailPaint()])
    if (state.name === 'history-unavailable-details') return {fixtureError: 'controlled recent history refusal'}
    if (state.name === 'live-details') {
      if (from <= 11 && to >= 11) return !state.held.has('detail-live') ? hold(state, 'detail-live', [detailPaint({block: 11, transaction: DETAIL_TX, rgb: 0x445566})]) : []
      return from <= 9 && to >= 9 ? [detailPaint()] : []
    }
    if (from > 9 || to < 9) return []
    if (state.name === 'late-history-details' || state.name === 'unavailable-details') return [detailPaint()]
    if (state.name === 'late-router-details') {
      const addresses = [filter.address].flat().map(value => value.toLowerCase())
      return [...(addresses.includes(R.toLowerCase()) ? [routerPaint] : []), detailPaint({painter: R})]
    }
    const addresses = [filter.address].flat().map(value => value.toLowerCase())
    const paint = {...canvasPaint, address: addresses.includes(B) ? B : A,
      topics: [canvasPaint.topics[0], addressTopic(node === 'b' && ['old-history', 'old-log-error'].includes(state.name) ? OTHER : R)]}
    return [...(addresses.includes(R.toLowerCase()) ? [routerPaint] : []), paint]
  }
  assert.fail('Unexpected RPC method: ' + call.method)
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin ?? 'http://127.0.0.1')
    const match = /^\/node\/([ab])\/(rpc|api\/info)$/.exec(url.pathname)
    if (match) {
      const state = active; assert.ok(state)
      response.setHeader('content-type', 'application/json')
      if (match[2] === 'api/info') {response.end(JSON.stringify({l2: {chainId: match[1] === 'a' ? 13370 : 13371}})); return}
      assert.equal(request.method, 'POST'); let text = ''
      for await (const part of request) {text += part; assert.ok(text.length <= 128 << 10)}
      const body = JSON.parse(text), batched = Array.isArray(body)
      const answer = async call => {const result = await rpc(state, match[1], call, batched)
        return {jsonrpc: '2.0', id: call.id, ...(result?.fixtureError ? {error: {code: -32005, message: result.fixtureError}} : {result})}}
      response.end(JSON.stringify(batched ? await Promise.all(body.map(answer)) : await answer(body))); return
    }
    if (url.pathname === '/fixture/storage') {response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Native storage witness</title>'); return}
    if (url.pathname === '/favicon.ico') {response.statusCode = 204; response.end(); return}
    assert.equal(request.method, 'GET'); assert.ok(url.pathname.startsWith(base))
    const relative = decodeURIComponent(url.pathname.slice(base.length)), path = resolve(root, relative || 'index.html')
    assert.ok(path === root || path.startsWith(root + '/'))
    const file = await stat(path).catch(() => null), selected = file?.isFile() ? path : resolve(root, 'index.html')
    const data = await readFile(selected), name = selected.slice(root.length + 1)
    delivered.set(name, {sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length})
    response.setHeader('content-type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'})[extname(selected)] ?? 'application/octet-stream')
    response.end(data)
  } catch (error) {errors.push(String(error)); response.statusCode = 500; response.end('Controlled fixture error')}
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port
const executablePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome'].find(existsSync)
assert.ok(executablePath, 'An installed Chrome is required; this control never downloads a browser')
let browser
const results = [], failures = []
async function stats(page) {return page.evaluate(() => Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim()))}
async function waitStats(page, painted, balance) {
  active.phase = 'current counters ' + painted + '/' + balance
  await page.waitForFunction((p, b) => {const rows = Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim())
    return Number(rows[0]?.replaceAll(',', '')) === p && Number(rows[2]?.replaceAll(',', '')) === b}, {timeout: 20_000}, painted, balance)
}
async function changeNode(page, url) {
  active.phase = 'actual node picker'
  await page.click('[data-testid="node-picker"]')
  await page.waitForSelector(NODE_RPC, {visible: true})
  await page.$eval(NODE_RPC, (input, value) => {input.value = value; input.dispatchEvent(new Event('input', {bubbles: true}))}, url)
  await page.$eval(NODE_RPC, input => input.closest('form').requestSubmit())
}
async function quiet(page) {active.phase = 'network idle after released HTTP replies'; await page.waitForNetworkIdle({idleTime: 250, timeout: 20_000}); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))}

const PIXEL = 500 * 1000 + 500
const draftKey = chain => `draft.${chain}.${A.toLowerCase()}`
const draftBytes = (index, rgb) => [index >> 16, index >> 8 & 255, index & 255, rgb >> 16, rgb >> 8 & 255, rgb & 255]
async function untilAsync(test, label) {const started = Date.now(); while (!await test()) {assert.ok(Date.now() - started < 20_000, label); await later(30)}}
async function badge(page, count) {
  active.phase = 'actual draft pixels ' + count
  await page.waitForFunction(n => Number(document.querySelector('.rail-badge')?.textContent.trim() ?? 0) === n, {timeout: 20_000}, count)
}
async function drawPixel(page, dx = 0, tool = 'b') {
  await page.keyboard.press(tool)
  const canvas = await page.$('[data-testid="board"]'), box = await canvas.boundingBox()
  assert.ok(box && box.width > 100 && box.height > 100)
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2)
}
async function canvasColour(page) {
  return page.$eval('[data-testid="board"]', canvas => Array.from(canvas.getContext('2d').getImageData(4, 4, 1, 1).data).slice(0, 3))
}
async function storageKeeper(context, seeds = {}) {
  const page = await context.newPage()
  await page.goto(origin + '/fixture/storage', {waitUntil: 'domcontentloaded'})
  await page.evaluate(async values => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('mozaic', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    })
    window.fixtureDB = db
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite'), store = tx.objectStore('kv')
      for (const [key, value] of Object.entries(values)) {if (value.length) store.put(new Uint8Array(value), key); else store.delete(key)}
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error)
    })
  }, seeds)
  return {
    async lock(mode = 'readwrite') {
      return page.evaluate(mode => new Promise((resolve, reject) => {
        const tx = window.fixtureDB.transaction('kv', mode), store = tx.objectStore('kv')
        const state = window.fixtureLock = {released: false, requests: 0, mode, started: Date.now(), timedOut: false}
        state.completed = new Promise((yes, no) => {tx.oncomplete = yes; tx.onabort = () => no(tx.error)})
        const pump = () => {
          const req = store.get('fixture-lock-marker')
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            if (++state.requests === 1) resolve({mode, actualNativeTransactionActive: true})
            if (Date.now() - state.started > 30_000) {state.timedOut = true; state.released = true}
            if (!state.released) pump()
          }
        }
        pump()
      }), mode)
    },
    async release() {return page.evaluate(async () => {const state = window.fixtureLock; state.released = true; await state.completed
      return {mode: state.mode, requests: state.requests, timedOut: state.timedOut, completed: true}})},
    async unlockIfHeld() {return page.evaluate(async () => {const state = window.fixtureLock; if (!state) return {held: false}
      state.released = true; await state.completed; return {held: true, requests: state.requests, timedOut: state.timedOut}})},
    async read(key) {return page.evaluate(key => new Promise((resolve, reject) => {
      const tx = window.fixtureDB.transaction('kv', 'readonly'), req = tx.objectStore('kv').get(key)
      let value; req.onsuccess = () => {value = req.result}; tx.oncomplete = () => resolve(value ? Array.from(value) : [])
      tx.onabort = () => reject(tx.error)
    }), key)},
    async legacy(key, ...values) {return page.evaluate(({key, value, write}) => {
      if (write) localStorage.setItem('mozaic.' + key, value)
      return localStorage.getItem('mozaic.' + key)
    }, {key, value: values[0] ?? null, write: values.length > 0})},
  }
}


async function selectDetailPixel(page) {
  active.phase = 'actual selected pixel and stationary pointer'
  const canvas = await page.$('[data-testid="board"]'), box = await canvas.boundingBox()
  assert.ok(box && box.width > 100 && box.height > 100)
  assert.equal(await canvas.evaluate(node => getComputedStyle(node).cursor), 'grab')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForSelector('[data-testid="pick"]', {visible: true})
  await page.waitForSelector('[data-testid="hud"]', {visible: true})
  assert.ok(await page.$eval('[data-testid="pick"]', node => node.textContent.includes('500, 500')))
}
async function detailArtist(page, address) {
  active.phase = 'selected and stationary hover attribution'
  await page.waitForFunction(address => {
    const selected = document.querySelector('[data-testid="pick-painter"]')
    const hover = document.querySelector('[data-testid="hud"]')
    return selected?.getAttribute('title')?.toLowerCase() === address.toLowerCase() &&
      Array.from(hover?.parentElement?.querySelectorAll('[title]') ?? []).some(node => node.getAttribute('title')?.toLowerCase() === address.toLowerCase())
  }, {timeout: 20_000}, address)
}
async function pickText(page, text) {
  active.phase = 'selected detail text: ' + text
  await page.waitForFunction(value => document.querySelector('[data-testid="pick"]')?.textContent.includes(value), {timeout: 20_000}, text)
}
async function pauseThroughPicker(page) {
  await page.click('[data-testid="node-picker"]')
  await page.waitForSelector(NODE_RPC, {visible: true})
  const buttons = await page.$$('button')
  let paused
  for (const button of buttons) if (await button.evaluate(node => node.textContent.trim() === 'Paused')) {paused = button; break}
  assert.ok(paused); await paused.click()
  await page.click('dialog[open] button[title="Close"]')
  await page.waitForSelector('dialog[open]', {hidden: true})
}

async function quietExceptHeld(page) {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))}


const gestureDraftCount = page => page.evaluate(() => Number(document.querySelector('.rail-badge')?.textContent.trim() ?? 0))
async function gestureReady(page) {
  await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
  const canvas = await page.$('[data-testid="board"]'), box = await canvas.boundingBox()
  assert.ok(box && box.width > 100 && box.height > 100)
  const session = await page.createCDPSession()
  await session.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 3})
  const point = (id, dx = 0, dy = 0) => ({id, x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy, radiusX: 1, radiusY: 1, force: 1})
  const touch = (type, touchPoints) => session.send('Input.dispatchTouchEvent', {type, touchPoints})
  return {canvas, box, session, point, touch}
}
async function gestureTool(page, key, large = false) {
  await page.keyboard.press(key)
  if (large) for (let i = 0; i < 23; i++) await page.keyboard.press(']')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="board"]')).cursor === 'crosshair')
}


async function showImageImport(page) {
  const chooser = page.waitForFileChooser()
  await page.click('[data-testid="import"]')
  await (await chooser).cancel()
  await page.waitForSelector('dialog[open] [data-testid="image-input"]')
}
async function imageReady(page) {
  await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
  const session = await page.createCDPSession(), urls = new Set()
  await session.send('Network.enable')
  session.on('Network.requestWillBeSent', event => {
    if (event.request.url.startsWith('blob:' + origin + '/')) urls.add(event.request.url)
  })
  await showImageImport(page)
  return {session, urls}
}
async function chooseImage(page, {name = 'picture.svg', colour = '#ff0000', png = false, closeNow = false} = {}) {
  const actual = await page.evaluate(async args => {
    let file
    if (args.png) {
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2
      const context = canvas.getContext('2d'); context.fillStyle = args.colour; context.fillRect(0,0,4,2)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Native PNG creation failed')
      file = new File([blob], args.name, {type: 'image/png'})
    } else {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 2" width="4" height="2"><rect width="4" height="2" fill="${args.colour}"/></svg>`
      file = new File([svg], args.name, {type: ''})
    }
    const input = document.querySelector('dialog[open] [data-testid="image-input"]')
    if (!input) throw new Error('The actual import file input is unavailable')
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
    input.dispatchEvent(new Event('change', {bubbles: true}))
    // A native decode awaits a promise. Closing in this same task precedes
    // its publication without replacing Image.decode or any product API.
    if (args.closeNow) document.querySelector('dialog[open] button[title="Close"]').click()
    return {name: file.name, type: file.type, bytes: file.size}
  }, {name, colour, png, closeNow})
  assert.ok(actual.bytes > 0 && actual.bytes <= 1024)
  return actual
}
// A one-bit PNG exercises native dimensions with a small encoded fixture.
function budgetPNG(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 1
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8)
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4)
    return bytes
  }
  const rows = Buffer.alloc((Math.ceil(width / 8) + 1) * height)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

function gifWithScreen(width, height, version = '89a') {
  const bytes = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex')
  bytes.write(version, 3, 'ascii')
  bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8)
  return bytes
}

function jpegSegment(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

function jpegPrefix(width, height, marker = 0xc0, metadataBytes = 0) {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3)
  const metadata = metadataBytes ? jpegSegment(0xef, Buffer.alloc(metadataBytes)) : Buffer.alloc(0)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), metadata, jpegSegment(marker, frame)])
}
function webpChunk(type, payload) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 'ascii'); header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)])
}

function webpFile(chunks) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

function webpCanvas(width, height, flags = 0) {
  const data = Buffer.alloc(10)
  data[0] = flags
  data.writeUIntLE(width - 1, 4, 3); data.writeUIntLE(height - 1, 7, 3)
  return webpChunk('VP8X', data)
}
// A constant one-component JPEG uses two zero Huffman bits per block.
function budgetJPEG(width, height) {
  const counts = Buffer.alloc(16); counts[0] = 1
  const tables = Buffer.concat([Buffer.from([0]), counts, Buffer.from([0, 0x10]), counts, Buffer.from([0])])
  const bits = 2 * Math.ceil(width / 8) * Math.ceil(height / 8)
  const scan = Buffer.alloc(Math.ceil(bits / 8))
  if (bits % 8) scan[scan.length - 1] = (1 << (8 - bits % 8)) - 1
  return Buffer.concat([jpegPrefix(width, height, 0xc0, 64), jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    jpegSegment(0xc4, tables), jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), scan, Buffer.from([0xff, 0xd9])])
}

// The zero-filled payload is a valid one-bit BMP with two palette entries.
function budgetBMP(width, height, {dib = 40, depth = 1, compression = 0} = {}) {
  const core = dib === 12
  const pixels = 14 + dib + (core ? 6 : 8)
  const body = compression === 0 ? Math.ceil(width * depth / 32) * 4 * Math.abs(height) : 2
  const total = pixels + body
  const header = Buffer.alloc(pixels)
  header.write('BM'); header.writeUInt32LE(total, 2); header.writeUInt32LE(pixels, 10); header.writeUInt32LE(dib, 14)
  if (core) {
    header.writeUInt16LE(width, 18); header.writeUInt16LE(height, 20)
    header.writeUInt16LE(1, 22); header.writeUInt16LE(depth, 24)
  } else {
    header.writeInt32LE(width, 18); header.writeInt32LE(height, 22)
    header.writeUInt16LE(1, 26); header.writeUInt16LE(depth, 28)
    header.writeUInt32LE(compression, 30); header.writeUInt32LE(body, 34)
  }
  return {header, total}
}

function smallIcon(cursor) {
  const png = budgetPNG(4, 2), directory = Buffer.alloc(22)
  directory.writeUInt16LE(cursor ? 2 : 1, 2); directory.writeUInt16LE(1, 4)
  directory[6] = 4; directory[7] = 2
  if (!cursor) {directory.writeUInt16LE(1, 10); directory.writeUInt16LE(1, 12)}
  directory.writeUInt32LE(png.length, 14); directory.writeUInt32LE(directory.length, 18)
  return Buffer.concat([directory, png])
}

async function chooseEncodedImage(page, bytes, name, type, total = bytes.length) {
  return page.evaluate(({encoded, name, type, total}) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const file = new File([bytes, new Uint8Array(total - bytes.length)], name, {type})
    const input = document.querySelector('dialog[open] [data-testid="image-input"]')
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
    input.dispatchEvent(new Event('change', {bubbles: true}))
    return {name: file.name, type: file.type, bytes: file.size}
  }, {encoded: bytes.toString('base64'), name, type, total})
}

async function transferFile(page, bytes, name, type = '', total = bytes.length) {
  return page.evaluateHandle(({encoded, name, type, total}) => {
    const header = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    return new File([header, new Uint8Array(total - header.length)], name, {type})
  }, {encoded: bytes.toString('base64'), name, type, total})
}

async function dialogAccessibleName(page, session, title) {
  const id = await page.evaluate(title => {
    const dialog = [...document.querySelectorAll('dialog[open]')].find(el => el.querySelector('h2')?.textContent.trim() === title)
    const heading = dialog?.querySelector('h2')
    return heading?.id && dialog.getAttribute('aria-labelledby') === heading.id ? heading.id : null
  }, title)
  assert.ok(id, 'The native dialog must reference its own visible heading')
  const {root} = await session.send('DOM.getDocument')
  const {nodeId} = await session.send('DOM.querySelector', {
    nodeId: root.nodeId, selector: 'dialog[open][aria-labelledby=' + JSON.stringify(id) + ']',
  })
  assert.ok(nodeId)
  const {nodes} = await session.send('Accessibility.getPartialAXTree', {nodeId, fetchRelatives: false})
  const dialog = nodes.find(node => !node.ignored && node.role?.value === 'dialog')
  assert.equal(dialog?.name?.value, title)
  return dialog.name.value
}

async function boardTransfer(page, route, file, {mixed = false, closeNow = false} = {}) {
  return page.evaluate(async (route, file, mixed, closeNow) => {
    const canvas = document.querySelector('[data-testid="board"]')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'Controlled text')
    if (mixed) transfer.items.add(new File(['Controlled file'], 'note.txt', {type: 'text/plain'}))
    if (file) transfer.items.add(file)
    const eventOptions = {bubbles: true, cancelable: true}
    const drag = route === 'drop' ? new DragEvent('dragover', {...eventOptions, dataTransfer: transfer}) : null
    if (drag) canvas.dispatchEvent(drag)
    const event = drag ? new DragEvent('drop', {...eventOptions, dataTransfer: transfer})
      : new ClipboardEvent('paste', {...eventOptions, clipboardData: transfer})
    canvas.dispatchEvent(event)
    if (closeNow) {
      // Allow Vue to open the actual modal and pass the file to its post-flush
      // watcher. Close in this task before an image can publish a preview.
      await Promise.resolve()
      const close = document.querySelector('dialog[open] button[title="Close"]')
      if (!close) throw new Error('The transferred file did not open the native dialog')
      close.click()
    }
    return {route, defaultPrevented: event.defaultPrevented, dragOverPrevented: drag?.defaultPrevented ?? null,
      closedInDispatchTask: closeNow, file: file ? {name: file.name, type: file.type, bytes: file.size} : null}
  }, route, file, mixed, closeNow)
}

async function smallImage(page) {
  await page.waitForSelector('dialog[open] [data-testid="as-stamp"]', {visible: true})
  await page.focus('[data-testid="image-width"]'); await page.keyboard.press('Home')
  await page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent.includes('4 x 2 px'))
}
const canReadImageURL = (page, url) => page.evaluate(async value => {
  try {return (await fetch(value)).ok} catch {return false}
}, url)
async function onlyImageURL(fixture, expected = 1) {
  await until(() => fixture.urls.size === expected, 'The real native image request must expose its object URL through CDP')
  return Array.from(fixture.urls).at(-1)
}
const boardCentreRGB = page => page.$eval('[data-testid="board"]', canvas => Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data).slice(0,3))


// Observe the real close event without replacing a product or platform API.
// Product DOM clicks and a microtask checkpoint reopen the same native element
// before the queued event can run as a later browser task.
async function reopenBeforeNativeClose(page, kind) {
  return page.evaluate(async selected => {
    const dialog=document.querySelector('dialog[open]')
    if(!dialog)throw new Error('The actual current native dialog is unavailable')
    let listener, timer
    const event=new Promise((resolve,reject)=>{
      listener=value=>resolve({trusted:value.isTrusted,targetMatches:value.target===dialog,openAtEvent:dialog.open})
      dialog.addEventListener('close',listener,{once:true})
      timer=setTimeout(()=>reject(new Error('The real queued native close event was not observed')),5000)
    })
    try {
      dialog.querySelector('button[title="Close"]').click()
      await Promise.resolve()
      const closedBeforeReopen=!dialog.open
      if(!closedBeforeReopen)throw new Error('The product had not closed its native dialog at the declared microtask boundary')
      let file=null
      if(selected==='image') {
        const svg='<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 4 2"><rect width="4" height="2" fill="blue"/></svg>'
        const image=new File([svg],'reopened.svg',{type:''}),transfer=new DataTransfer();transfer.items.add(image)
        document.querySelector('[data-testid="board"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))
        file={name:image.name,type:image.type,bytes:image.size}
      } else {
        document.querySelector('[data-testid="node-picker"]').click()
      }
      await Promise.resolve()
      const reopenedBeforeEvent=dialog.open
      if(!reopenedBeforeEvent)throw new Error('The same product dialog did not reopen before the native close event')
      const actual=await event
      await Promise.resolve()
      return {sameElement:dialog===document.querySelector('dialog[open]'),closedBeforeReopen,
        reopenedBeforeEvent,openAfterEvent:dialog.open,nativeEvent:actual,controlledFile:file,observationCapMs:5000}
    } finally {
      clearTimeout(timer);dialog.removeEventListener('close',listener)
    }
  },kind)
}

async function failureDetail(error, state, page) {
  const observed = await Promise.race([
    page.evaluate(() => ({visibility: document.visibilityState,
      stats: Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim()),
      draftPixels: Number(document.querySelector('.rail-badge')?.textContent.trim() ?? 0),
      canvasRGB: (() => {const c = document.querySelector('[data-testid="board"]'); return c ? Array.from(c.getContext('2d').getImageData(4, 4, 1, 1).data).slice(0, 3) : null})()})),
    later(1000).then(() => null),
  ]).catch(() => null)
  return {case: state.name, source, phase: state.phase, errorType: error.name,
    message: String(error.message).slice(0, 240), observed,
    heldReplies: Array.from(state.held, ([name, row]) => ({name, released: row.released === true})),
    RPCRequests: state.calls.length, contractRequests: state.contractCalls.length}
}

try {
  browser = await puppeteer.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run']})
  const browserVersion = await browser.version()
  for (const name of ['old-head', 'old-totals', 'late-router', 'unavailable', 'old-chunk', 'old-history', 'old-log-error', 'canvas-switch', 'draft-context', 'draft-fast-return', 'draft-storage-reload', 'legacy-storage-migration', 'draft-concurrent-recovery', 'late-history-details', 'late-router-details', 'live-details', 'history-unavailable-details', 'unavailable-details', 'pointer-cancel', 'held-pointer-context', 'pinch-spray', 'deferred-route', 'view-dimensions', 'image-stamp', 'image-close', 'image-replace-guide', 'image-close-pending', 'image-drop', 'image-queued-close', 'image-native-escape', 'node-modal-queued-close', 'image-alpha-count', 'image-stamp-overlap', 'image-tall-preview', 'image-paste-svg', 'image-source-budget', 'image-transfer-budget', 'modal-focus-keyboard']) {
    active = {name, held: new Map(), calls: [], contractCalls: []}; const state = active
    console.log('MOZAIC-BOARD-BROWSER-START ' + JSON.stringify({case: name, source}))
    const context = await browser.createBrowserContext(), page = await context.newPage()
    let keeper, legacyValue
    const caseStart = results.length, errorStart = errors.length, unexpectedStart = unexpected.length
    state.phase = 'setup'
    try {
    const preparePage = async page => {
      page.setDefaultTimeout(20_000); await page.setViewport({width: 1440, height: 1000})
      page.on('pageerror', error => errors.push(String(error)))
      await page.setRequestInterception(true)
      page.on('request', request => {
        const url = request.url()
        if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) void request.continue()
        else {unexpected.push(new URL(url).origin); void request.abort('blockedbyclient')}
      })
    }
    await preparePage(page)
    if (['draft-context', 'draft-fast-return', 'draft-storage-reload', 'legacy-storage-migration'].includes(name)) {
      const seeds = {[draftKey(13370)]: name === 'draft-context' || name === 'draft-fast-return' ? draftBytes(1, 0xff0000) : [],
        [draftKey(13371)]: name === 'draft-context' ? draftBytes(2, 0x00ff00) : []}
      keeper = await storageKeeper(context, seeds)
      if (name === 'draft-context') await keeper.lock()
      if (name === 'legacy-storage-migration') {legacyValue = Buffer.from(draftBytes(1, 0xff0000)).toString('hex'); await keeper.legacy(draftKey(13370), legacyValue); await keeper.lock('readonly')}
    }
    if (name === 'draft-concurrent-recovery') keeper = await storageKeeper(context, {[draftKey(13370)]: draftBytes(1, 0xff0000)})
    if (name === 'image-stamp-overlap') keeper = await storageKeeper(context)
    const query = new URLSearchParams({rpc: origin + '/node/a/rpc', contract: A, x: (DETAIL_CASES.includes(name) || GESTURE_CASES.includes(name) || IMAGE_CASES.includes(name) || MODAL_CASES.includes(name)) ? '500' : '0', y: (DETAIL_CASES.includes(name) || GESTURE_CASES.includes(name) || IMAGE_CASES.includes(name) || MODAL_CASES.includes(name)) ? '500' : '0', z: '8', ...(['late-router', 'late-router-details'].includes(name) ? {router: R} : {})})
    if (name === 'draft-concurrent-recovery') {query.set('x', '500'); query.set('y', '500')}
    if (name === 'image-stamp-overlap') query.set('x', '999')
    // Opening the keeper tab can background the product. Its real visibility
    // and animation-frame polling must match the foreground UI under test.
    await page.bringToFront()
    state.phase = 'production entry'
    await page.goto(origin + base + '?' + query, {waitUntil: 'domcontentloaded'})
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
    await page.waitForSelector('[data-testid="node-picker"]')
    if (name === 'old-head') {
      await until(() => state.held.has('head'), 'The original A snapshot head must actually be pending')
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8)
      const before = state.contractCalls.filter(row => row.node === 'b' && row.functionName === 'chunk').length
      assert.equal(before, 10); state.held.get('head').release(); await quiet(page)
      const after = state.contractCalls.filter(row => row.node === 'b' && row.functionName === 'chunk').length
      assert.equal(after, 10); await waitStats(page, 7, 8)
      results.push({case: name, currentSnapshotChunksBeforeOldReply: before, currentSnapshotChunksAfterOldReply: after, observedStats: await stats(page), pass: true})
    } else if (name === 'old-totals') {
      await until(() => state.held.has('painted') && state.held.has('balance'), 'Both original A counter responses must actually be held')
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8)
      state.held.get('painted').release(encode(MOZAIC_ABI, 'painted', 41n)); state.held.get('balance').release(hex(42n * 10n ** 18n))
      await quiet(page); await waitStats(page, 7, 8)
      results.push({case: name, stalePaintedReply: '41', staleBalanceReplyZNN: '42', observedStats: await stats(page), pass: true})
    } else if (name === 'late-router') {
      await until(() => state.held.has('router'), 'The original router validation must actually be pending')
      await waitStats(page, 5, 6)
      await page.waitForFunction(() => document.querySelector('.stats-body')?.textContent.includes('0x3333'))
      await page.keyboard.press('b'); const board = await page.$('.board canvas:not(.minimap)'), box = await board.boundingBox()
      assert.ok(box && box.width > 100 && box.height > 100); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForFunction(() => document.querySelector('.rail-badge')?.textContent.trim() === '1')
      const before = state.contractCalls.filter(row => row.functionName === 'chunk').length; assert.equal(before, 10)
      state.held.get('router').release(); await quiet(page)
      await page.waitForFunction(() => document.querySelector('.stats-body')?.textContent.includes('0x4444'))
      assert.equal(state.contractCalls.filter(row => row.functionName === 'chunk').length, 10)
      assert.equal(await page.$eval('.rail-badge', node => node.textContent.trim()), '1')
      await page.click('[data-testid="nav-gallery"]'); await page.waitForSelector('[data-testid="gallery-view"]', {visible: true})
      await page.click('[data-testid="leave-gallery"]'); await page.waitForSelector('[data-testid="node-picker"]')
      assert.equal(await page.$eval('.rail-badge', node => node.textContent.trim()), '1')
      results.push({case: name, currentSnapshotChunks: before, routerAttributionUpdatedInDOM: true, actualDraftPixelsAfterRouterAndGalleryRoundTrip: 1, actualGalleryEntryAndExit: true, pass: true})
    } else if (name === 'old-chunk' || name === 'canvas-switch') {
      await until(() => state.held.has('chunk'), 'The original A chunk must actually be held')
      if (name === 'canvas-switch') {
        await page.click('[data-testid="node-picker"]'); await page.waitForSelector(NODE_CONTRACT, {visible: true})
        await page.$eval(NODE_CONTRACT, (input, value) => {input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); input.closest('form').requestSubmit()}, B)
      } else await changeNode(page, origin + '/node/b/rpc')
      await waitStats(page, 7, 8)
      // The obsolete HTTP reply is intentionally pending. Observe the current
      // rendered pixel instead of waiting for that held request to become idle.
      await page.waitForFunction(() => {
        const data = document.querySelector('[data-testid="board"]').getContext('2d').getImageData(4, 4, 1, 1).data
        return data[0] === 68 && data[1] === 102 && data[2] === 136
      }, {timeout: 20_000})
      const before = await canvasColour(page); assert.deepEqual(before, [68, 102, 136])
      state.held.get('chunk').release(); await quiet(page)
      const after = await canvasColour(page); assert.deepEqual(after, before)
      const chunks = state.contractCalls.filter(row => row.functionName === 'chunk' && (name === 'canvas-switch' ? row.to.toLowerCase() === B : row.node === 'b')).length
      assert.equal(chunks, 10)
      results.push({case: name, originalChunkHeldAndReleased: true, actualCurrentCanvasRGBBefore: before, actualCurrentCanvasRGBAfter: after,
        currentSnapshotChunks: chunks, actualNodeOrCanvasPickerUsed: true, observedStats: await stats(page), pass: true})
    } else if (name === 'old-history' || name === 'old-log-error') {
      await until(() => state.held.has('history'), 'The original A history request must actually be held')
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8)
      // Current history can render while the old HTTP request remains held.
      await page.waitForFunction(() => document.querySelector('.stats-body')?.textContent.includes('0x5555'))
      const before = state.calls.filter(row => row.method === 'eth_getLogs').map(row => row.node)
      state.held.get('history').release(name === 'old-log-error' ? {fixtureError: 'controlled obsolete range refusal'} : [canvasPaint])
      await quiet(page)
      assert.deepEqual(state.calls.filter(row => row.method === 'eth_getLogs').map(row => row.node), before)
      assert.ok(await page.$eval('.stats-body', node => node.textContent.includes('0x5555') && !node.textContent.includes('0x3333')))
      results.push({case: name, originalHistoryHeldAndReleased: true, obsoleteReplyOrErrorStartedNoExtraLogRequests: true,
        currentArtistRetainedInActualDOM: true, pass: true})
    } else if (name === 'draft-context') {
      await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8); await quiet(page); await badge(page, 0)
      const held = await keeper.release(); assert.ok(held.requests > 0 && !held.timedOut && held.completed)
      await badge(page, 1); await quiet(page); await badge(page, 1)
      const stored = await keeper.read(draftKey(13371)); assert.equal(stored.length, 6)
      results.push({case: name, actualNativeIndexedDBReadwriteLock: true, heldTransactionRequests: held.requests,
        twoDistinctSeededDraftKeys: true, currentDraftPixelsAfterOldAndCurrentReads: 1, actualNodePickerUsed: true, pass: true})
    } else if (name === 'draft-fast-return') {
      await waitStats(page, 5, 6); await badge(page, 1); await quiet(page)
      const lock = await keeper.lock(); assert.ok(lock.actualNativeTransactionActive)
      await drawPixel(page); await badge(page, 2)
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8); await quiet(page)
      await changeNode(page, origin + '/node/a/rpc'); await waitStats(page, 5, 6); await badge(page, 2)
      const unsaved = 2, held = await keeper.release(); assert.ok(held.requests > 0 && !held.timedOut)
      await quiet(page); await badge(page, 2)
      await untilAsync(async () => (await keeper.read(draftKey(13370))).length === 12, 'Both A pixels must actually commit')
      results.push({case: name, actualNativeIndexedDBReadwriteLock: true, unsavedPixelsVisibleBeforeStorageUnlock: unsaved,
        actualNodePickerRoundTrip: ['a', 'b', 'a'], actualCommittedDraftBytes: 12, pass: true})
    } else if (name === 'draft-storage-reload') {
      await waitStats(page, 5, 6); await quiet(page); await drawPixel(page); await badge(page, 1)
      await untilAsync(async () => (await keeper.read(draftKey(13370))).length === 6, 'The drawn pixel must actually commit before reload')
      const saved = await keeper.read(draftKey(13370))
      await page.reload({waitUntil: 'domcontentloaded'}); await waitStats(page, 5, 6); await badge(page, 1); await quiet(page)
      assert.deepEqual(await keeper.read(draftKey(13370)), saved)
      results.push({case: name, actualPointerDrawing: true, actualPageReload: true, actualCommittedDraftBytes: saved.length,
        restoredActualDraftPixels: 1, pass: true})
    } else if (name === 'legacy-storage-migration') {
      await waitStats(page, 5, 6); await badge(page, 1); await later(1300)
      assert.equal(await keeper.legacy(draftKey(13370)), legacyValue)
      const held = await keeper.release(); assert.equal(held.mode, 'readonly'); assert.ok(held.requests > 0 && !held.timedOut)
      await untilAsync(async () => await keeper.legacy(draftKey(13370)) === null, 'Legacy bytes remain until an actual write transaction completes')
      const stored = await keeper.read(draftKey(13370)); assert.equal(stored.length, 6); await badge(page, 1)
      results.push({case: name, actualNativeIndexedDBReadonlyLock: true, legacyRetainedWhileWriteBlocked: true,
        legacyRemovedOnlyAfterActualCommit: true, actualCommittedDraftBytes: stored.length, pass: true})
    } else if (name === 'draft-concurrent-recovery') {
      const key = draftKey(13370), seed = draftBytes(1, 0xff0000)
      await waitStats(page, 5, 6); await badge(page, 1)
      const second = await context.newPage()
      await preparePage(second); await second.bringToFront()
      await second.goto(page.url(), {waitUntil: 'domcontentloaded'})
      await waitStats(second, 5, 6); await badge(second, 1)
      await page.bringToFront()

      // Both actual views have already loaded the same single stored pixel.
      await drawPixel(page, -32); await badge(page, 2)
      await untilAsync(async () => (await keeper.read(key)).length === 12, 'The first tab must commit its own edit')
      const first = await keeper.read(key)
      assert.deepEqual(first.slice(0, 6), seed)
      await second.bringToFront(); await drawPixel(second, 32); await badge(second, 2)
      await untilAsync(async () => (await keeper.read(key)).length === 18, 'The stale second tab must retain the first edit')
      const merged = await keeper.read(key)
      assert.deepEqual(merged.slice(0, 12), first)

      await page.bringToFront(); await drawPixel(page, -32, 'e'); await badge(page, 1)
      await untilAsync(async () => (await keeper.read(key)).length === 12, 'Erasing must remove only the selected pixel')
      const committed = [...seed, ...merged.slice(12)]
      assert.deepEqual(await keeper.read(key), committed)

      // A native readonly transaction lets other readers through until a writer queues.
      // Close the writing page while it is waiting, then check the whole prior record.
      await second.bringToFront()
      state.phase = 'hold storage and close the writing tab'
      assert.ok((await keeper.lock('readonly')).actualNativeTransactionActive)
      assert.deepEqual(await keeper.read(key), committed)
      await drawPixel(second, 64); await badge(second, 3)
      await later(1300)
      let settled = false
      const waiting = keeper.read(key).then(value => {settled = true; return value})
      await later(120)
      assert.equal(settled, false, 'The new readonly request must be waiting behind the blocked product writer')
      await second.close({runBeforeUnload: false})
      assert.ok(second.isClosed())
      const released = await keeper.release()
      assert.ok(released.completed && !released.timedOut && released.requests > 0)
      assert.deepEqual(await waiting, committed)

      await page.bringToFront(); await page.reload({waitUntil: 'domcontentloaded'})
      await waitStats(page, 5, 6); await badge(page, 2)
      assert.deepEqual(await keeper.read(key), committed)
      results.push({case: name, twoActualProductTabsOnSameOrigin: true, actualInitialSharedPixels: 1,
        actualMergedDraftBytes: merged, actualCommittedDraftBytes: committed,
        actualErasedPixelStayedAbsent: true, actualNativeWriterBlockedBeforeTabClose: true,
        actualTabClosedBeforeUnlock: true, actualPageReload: true, actualRestoredPixels: 2, pass: true})
    } else if (name === 'late-history-details') {
      await until(() => state.held.has('detail-history'), 'The original current history must be held')
      await waitStats(page, 5, 6); await selectDetailPixel(page)
      await pickText(page, 'Reading recent activity...')
      assert.equal(await page.$('[data-testid="pick-painter"]'), null)
      state.held.get('detail-history').release(); await quiet(page); await detailArtist(page, ARTIST)
      await pickText(page, 'block 9')
      assert.equal(state.contractCalls.filter(row => row.functionName === 'chunk').length, 10)
      results.push({case: name, actualPointerSelection: true, stationaryPointerAndSelectionUpdatedAfterHistory: true,
        actualSelectedPainter: ARTIST, actualSelectedBlock: 9, loadingKnowledgeVisibleBeforeReply: true, currentSnapshotChunks: 10, pass: true})
    } else if (name === 'late-router-details') {
      await until(() => state.held.has('router'), 'The original router validation must be held')
      await waitStats(page, 5, 6)
      await page.waitForFunction(() => document.querySelector('.stats-body')?.textContent.includes('0x3333'))
      await quietExceptHeld(page); await selectDetailPixel(page); await detailArtist(page, R)
      state.held.get('router').release(); await quiet(page); await detailArtist(page, ARTIST)
      assert.equal(state.contractCalls.filter(row => row.functionName === 'chunk').length, 10)
      results.push({case: name, actualPointerSelection: true, stationaryPointerAndSelectionUpdatedAfterRouter: true,
        priorSelectedPainter: R, actualSelectedPainter: ARTIST, currentSnapshotChunks: 10, pass: true})
    } else if (name === 'live-details') {
      await waitStats(page, 5, 6); await quiet(page); await selectDetailPixel(page); await detailArtist(page, ARTIST)
      await pickText(page, 'block 9')
      state.head = 300; await pauseThroughPicker(page)
      await until(() => state.held.has('detail-live'), 'Current live logs must actually be held after the real picker changes cadence')
      await pickText(page, '1 h ago'); await pickText(page, 'block 9')
      assert.equal(state.held.get('detail-live').released, undefined)
      state.held.get('detail-live').release(); await quiet(page); await pickText(page, 'block 11')
      const tx = await page.$eval('[data-testid="pick"] a[href*="/tx/"]', node => node.href)
      assert.equal(tx, origin + '/node/a/tx/' + DETAIL_TX)
      await pickText(page, '#445566')
      results.push({case: name, actualPointerSelection: true, actualCadencePickerUsed: true,
        selectedAgeUpdatedWhileLiveLogsPending: '1 h ago', priorSelectedBlockWhilePending: 9,
        actualSelectedBlockAfterLiveReply: 11, actualSelectedTransaction: DETAIL_TX,
        actualSelectedColour: '#445566', pass: true})
    } else if (name === 'history-unavailable-details') {
      await until(() => state.held.has('detail-history'), 'The original failing history must actually be held')
      await waitStats(page, 5, 6); await selectDetailPixel(page); await pickText(page, 'Reading recent activity...')
      state.held.get('detail-history').release({fixtureError: 'controlled recent history refusal'})
      await quiet(page); await pickText(page, 'Recent activity could not be read.')
      assert.equal(await page.$('[data-testid="pick-painter"]'), null)
      results.push({case: name, actualPointerSelection: true, failedHistoryDoesNotClaimNoPaint: true,
        actualSelectedKnowledge: 'Recent activity could not be read.', currentSnapshotRemainsReady: true,
        actualHistoryRequests: state.calls.filter(row => row.method === 'eth_getLogs').length, pass: true})
    } else if (name === 'unavailable-details') {
      await waitStats(page, 5, 6); await quiet(page); await selectDetailPixel(page); await detailArtist(page, ARTIST)
      await changeNode(page, ''); await pickText(page, 'Canvas details are unavailable.'); await pickText(page, '#ffffff')
      assert.equal(await page.$('[data-testid="pick-painter"]'), null)
      assert.equal(await page.$('[data-testid="pick"] a[href*="/tx/"]'), null)
      results.push({case: name, actualPointerSelection: true, actualInvalidNodePickerUsed: true,
        oldSelectedPainterAndTransactionCleared: true, actualSelectedColour: '#ffffff',
        actualSelectedKnowledge: 'Canvas details are unavailable.', pass: true})

    } else if (name === 'pointer-cancel') {
      const g = await gestureReady(page); await gestureTool(page, 'r')
      const before = createHash('sha256').update(await g.canvas.screenshot()).digest('hex')
      await g.touch('touchStart', [g.point(1)]); await g.touch('touchMove', [g.point(1, 24, 16)]); await quietExceptHeld(page)
      const preview = createHash('sha256').update(await g.canvas.screenshot()).digest('hex')
      assert.notEqual(preview, before); await badge(page, 0)
      await g.touch('touchCancel', []); await later(120); await badge(page, 0)
      await g.touch('touchStart', [g.point(1)]); await g.touch('touchMove', [g.point(1, 24, 16)]); await g.touch('touchEnd', [])
      await untilAsync(async () => await gestureDraftCount(page) > 0, 'A fresh owned shape must still commit through real input')
      results.push({case: name, actualCDPTouchCancellation: true, actualPreviewChangedRenderedCanvas: true,
        actualCancelledDraftPixels: 0, actualNextOwnedShapeDraftPixels: await gestureDraftCount(page), pass: true})
    } else if (name === 'held-pointer-context') {
      const g = await gestureReady(page); await gestureTool(page, 's', true)
      await g.touch('touchStart', [g.point(1)])
      await untilAsync(async () => await gestureDraftCount(page) > 0, 'The held original spray must really draw')
      const originalPixels = await gestureDraftCount(page)
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8); await quiet(page); await badge(page, 0)
      await g.touch('touchMove', [g.point(1, 20, 20)]); await later(250); await g.touch('touchEnd', []); await quietExceptHeld(page); await badge(page, 0)
      results.push({case: name, actualHeldTouchAndSprayBeforeNodeChange: true, actualOriginalNodeDraftPixels: originalPixels,
        actualNodePickerUsed: true, actualLaterNodeDraftPixels: 0, oldPointerMoveAndReleaseDidNotWrite: true,
        currentSnapshotChunks: state.contractCalls.filter(row => row.node === 'b' && row.functionName === 'chunk').length, pass: true})
    } else if (name === 'pinch-spray') {
      const g = await gestureReady(page); await gestureTool(page, 's', true)
      await g.touch('touchStart', [g.point(1, -24)])
      await untilAsync(async () => await gestureDraftCount(page) > 0, 'The spray must draw before the second finger')
      await g.touch('touchStart', [g.point(1, -24), g.point(2, 24)]); await quietExceptHeld(page)
      const before = await gestureDraftCount(page)
      await g.touch('touchMove', [g.point(1, -40), g.point(2, 40)]); await later(260); await quietExceptHeld(page)
      assert.equal(await gestureDraftCount(page), before)
      await g.touch('touchEnd', []); await later(450)
      const zoom = Number(new URL(page.url()).searchParams.get('z')); assert.ok(zoom > 8)
      results.push({case: name, actualTwoTouchPinch: true, actualSprayDraftPixelsAtTakeover: before,
        actualDraftPixelsAfterPinch: await gestureDraftCount(page), actualPinchChangedURLZoom: zoom,
        stoppedHeldSprayWhilePreservingCameraInput: true, pass: true})
    } else if (name === 'deferred-route') {
      await waitStats(page, 5, 6); await quiet(page); await later(450)
      const session = await page.createCDPSession(); await session.send('Page.enable')
      const navigations = []; let started = 0
      session.on('Page.navigatedWithinDocument', event => navigations.push({url: event.url, elapsed: Date.now() - started}))
      const canvas = await page.$('[data-testid="board"]'), box = await canvas.boundingBox(); assert.ok(box)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      started = Date.now(); await page.mouse.wheel({deltaY: -100}); await page.click('[data-testid="nav-gallery"]')
      await page.waitForSelector('[data-testid="gallery-view"]', {visible: true}); await later(850)
      const gallery = navigations.filter(row => new URL(row.url).pathname === base + 'gallery')
      assert.ok(gallery.length > 0 && gallery[0].elapsed < 400, 'The real route must change while the old 400 ms view write is still pending')
      const view = url => {const q = new URL(url).searchParams; return ['x','y','z'].map(key => q.get(key))}
      for (const row of gallery) assert.deepEqual(view(row.url), view(gallery[0].url))
      results.push({case: name, actualWheelInputAndGalleryNavigation: true, actualNavigationElapsedMs: gallery[0].elapsed,
        actualSameDocumentNavigationEvents: gallery.length, actualGalleryViewQuery: view(gallery[0].url),
        obsoleteViewDidNotRewriteTheNextRoute: true, pass: true})
    } else if (name === 'view-dimensions') {
      await waitStats(page, 5, 6); await quiet(page); await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8); await quiet(page)
      const pixels = await page.$eval('[data-testid="board"]', canvas => {
        const context = canvas.getContext('2d'), sample = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
        const reference = document.createElement('canvas'); reference.width = reference.height = 1
        const c = reference.getContext('2d'); c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--sunk').trim(); c.fillRect(0, 0, 1, 1)
        return {uncoveredBackground: Array.from(c.getImageData(0, 0, 1, 1).data).slice(0, 3),
          corners: [[4,4],[canvas.width-5,4],[4,canvas.height-5],[canvas.width-5,canvas.height-5]].map(([x,y]) => sample(x,y))}
      })
      for (const corner of pixels.corners) assert.notDeepEqual(corner, pixels.uncoveredBackground)
      const chunks = state.contractCalls.filter(row => row.node === 'b' && row.functionName === 'chunk').length; assert.equal(chunks, 1)
      results.push({case: name, actualNodePickerUsed: true, controlledNewCanvasDimensions: [40,40], currentSnapshotChunks: chunks,
        actualRenderedCornerRGB: pixels.corners, actualUncoveredBackgroundRGB: pixels.uncoveredBackground,
        currentCanvasStillCoversTheBoard: true, pass: true})

    } else if (name === 'image-stamp') {
      state.phase = 'actual PNG input, resource release and stamp placement'
      const f = await imageReady(page)
      const file = await chooseImage(page, {name: 'stamp.png', png: true}); await smallImage(page)
      const url = await onlyImageURL(f); assert.equal(await canReadImageURL(page,url), false)
      await page.click('[data-testid="as-stamp"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      const box = await (await page.$('[data-testid="board"]')).boundingBox(); assert.ok(box)
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2); await badge(page,8)
      results.push({case:name,actualNativePNGFileAndFileInputChange:true,actualCancelledNativeFileChooser:true,
        actualRangeKeyboardUsed:true,actualScaledStampDimensions:[4,2],actualDraftPixels:8,
        actualRasterObjectURLReleasedAfterDecode:true,actualPlacedCanvasSurvivesDecodedSourceDisposal:true,
        controlledFile:file,observedObjectURLSHA256:createHash('sha256').update(url).digest('hex'),pass:true})
    } else if (name === 'image-close') {
      state.phase = 'actual SVG import close and explicit resource lifetime'
      const f=await imageReady(page); const file=await chooseImage(page); await smallImage(page)
      const url=await onlyImageURL(f); assert.equal(await canReadImageURL(page,url),true)
      await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      assert.equal(await canReadImageURL(page,url),false)
      await showImageImport(page); assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'),null)
      await page.click('dialog[open] button[title="Close"]'); await badge(page,0)
      results.push({case:name,actualMIMEEmptySVGAndNativeDecoder:true,actualNativeObjectURLReadableBeforeClose:true,
        actualNativeObjectURLUnreadableAfterClose:true,actualReopenedDialogHasNoOldPreview:true,
        actualDraftPixels:0,controlledFile:file,observedObjectURLSHA256:createHash('sha256').update(url).digest('hex'),pass:true})
    } else if (name === 'image-replace-guide') {
      state.phase = 'actual SVG replacement, guide raster and resource release'
      const f=await imageReady(page); await chooseImage(page,{name:'first.svg'}); await smallImage(page)
      const first=await onlyImageURL(f); assert.equal(await canReadImageURL(page,first),true)
      await chooseImage(page,{name:'second.svg',colour:'#0000ff'}); await smallImage(page)
      const second=await onlyImageURL(f,2); assert.notEqual(first,second)
      assert.equal(await canReadImageURL(page,first),false); assert.equal(await canReadImageURL(page,second),true)
      const before=await boardCentreRGB(page)
      await page.evaluate(() => {
        const button=Array.from(document.querySelectorAll('dialog[open] button')).find(node => node.textContent.includes('Pin as a guide'))
        if(!button)throw new Error('The actual guide action is unavailable');button.click()
      })
      await page.waitForFunction(() => !document.querySelector('dialog[open]')); await quietExceptHeld(page)
      const after=await boardCentreRGB(page);assert.notDeepEqual(after,before);assert.ok(after[2]>after[0] && after[2]>after[1])
      assert.equal(await canReadImageURL(page,second),false);await badge(page,0)
      results.push({case:name,actualTwoSVGFileInputSelections:true,actualReplacedObjectURLReleased:true,
        actualCurrentObjectURLReadableBeforePlacement:true,actualCurrentObjectURLReleasedAfterGuidePlacement:true,
        actualGuideStillRenderedAfterSourceDisposal:true,actualRenderedRGBBefore:before,actualRenderedRGBAfter:after,
        actualDraftPixels:0,observedDistinctObjectURLs:f.urls.size,pass:true})
    } else if (name === 'image-close-pending') {
      state.phase = 'same-task actual file change and close before decode publication'
      await imageReady(page);const file=await chooseImage(page,{closeNow:true})
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));await later(250)
      await showImageImport(page);assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'),null)
      await page.click('dialog[open] button[title="Close"]');await badge(page,0)
      results.push({case:name,actualFileInputChangeAndCloseInOneTask:true,actualImageAndProductAPIsUnmodified:true,
        actualReopenedDialogRejectsLatePreview:true,actualDraftPixels:0,controlledFile:file,pass:true})

    } else if (name === 'image-drop') {
      state.phase = 'actual parent file-drop props and settled native import action'
      await waitStats(page,5,6);await quiet(page);await badge(page,0)
      const picker=page.waitForFileChooser({timeout:1500}).then(async value=>{await value.cancel();return true},error=>{
        if(error.name!=='TimeoutError')throw error
        return false
      })
      const file=await page.evaluate(()=>{
        const svg='<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 4 2"><rect width="4" height="2" fill="red"/></svg>'
        const file=new File([svg],'drop.svg',{type:''}),transfer=new DataTransfer();transfer.items.add(file)
        const canvas=document.querySelector('[data-testid="board"]')
        if(!canvas)throw new Error('The actual file-drop board is unavailable')
        canvas.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))
        return {name:file.name,type:file.type,bytes:file.size}
      })
      await smallImage(page);const opened=await picker;assert.equal(opened,false)
      await page.click('dialog[open] button[title="Close"]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));await badge(page,0)
      results.push({case:name,actualNativeFileBlobAndBoardDropEvent:true,actualParentOpenAndFilePropsUsed:true,
        actualDroppedSVGDecodedInActualDialog:true,actualUnwantedNativeFileChoosers:0,
        actualFileChooserObservationWindowMs:1500,actualRangeKeyboardUsed:true,actualDraftPixels:0,controlledFile:file,pass:true})

    } else if (name === 'image-queued-close') {
      state.phase = 'actual image close and reopen before its queued native close event'
      const f=await imageReady(page);await chooseImage(page,{name:'first-open.svg'});await smallImage(page)
      const first=await onlyImageURL(f)
      const transition=await reopenBeforeNativeClose(page,'image')
      assert.equal(transition.closedBeforeReopen,true);assert.equal(transition.reopenedBeforeEvent,true)
      assert.equal(transition.nativeEvent.trusted,true);assert.equal(transition.nativeEvent.targetMatches,true)
      assert.equal(transition.nativeEvent.openAtEvent,true);assert.equal(transition.openAfterEvent,true);assert.equal(transition.sameElement,true)
      await smallImage(page);const current=await onlyImageURL(f,2)
      assert.notEqual(first,current);assert.equal(await canReadImageURL(page,first),false);assert.equal(await canReadImageURL(page,current),true)
      await page.click('dialog[open] button[title="Close"]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
      assert.equal(await canReadImageURL(page,current),false);await badge(page,0)
      results.push({case:name,actualProductDOMCloseAndBoardDrop:true,actualSameNativeElementReopenedBeforeQueuedClose:true,
        actualTrustedQueuedCloseObserved:true,actualNewOpeningAndDecodedPreviewSurviveOldEvent:true,
        actualPreviousURLReleasedAndCurrentURLRetained:true,actualCurrentURLReleasedOnlyAfterCurrentClose:true,
        actualNativeDialogAndProductAPIsUnmodified:true,actualDraftPixels:0,transition,pass:true})
    } else if (name === 'image-native-escape') {
      state.phase = 'current native Escape still closes the image dialog and releases its source'
      const f=await imageReady(page);await chooseImage(page,{name:'escape.svg'});await smallImage(page)
      const first=await onlyImageURL(f);assert.equal(await canReadImageURL(page,first),true)
      state.phase = 'current native Escape before parent preview retirement'
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
      // Native closure precedes its queued close notification to the parent.
      // The hidden dialog still contains its preview until that owner retires it.
      await page.waitForFunction(()=>!document.querySelector('dialog [data-testid="as-stamp"]'))
      state.phase = 'parent preview retired before current Escape resource check'
      assert.equal(await canReadImageURL(page,first),false)
      const file=await page.evaluate(()=>{
        const svg='<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 4 2"><rect width="4" height="2" fill="green"/></svg>'
        const image=new File([svg],'after-escape.svg',{type:''}),transfer=new DataTransfer();transfer.items.add(image)
        document.querySelector('[data-testid="board"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))
        return {name:image.name,type:image.type,bytes:image.size}
      })
      await smallImage(page);const current=await onlyImageURL(f,2);assert.equal(await canReadImageURL(page,current),true)
      await page.click('dialog[open] button[title="Close"]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
      assert.equal(await canReadImageURL(page,current),false);await badge(page,0)
      results.push({case:name,actualNativeEscapeKey:true,actualCurrentEscapeClosesDialog:true,actualParentPreviewRetirementObservedBeforeResourceCheck:true,actualEscapeReleasesNativeSVGURL:true,
        actualFreshDropAndNativePreviewRecoverAfterEscape:true,actualNextCurrentCloseStillReleasesSource:true,
        actualNativeDialogAndProductAPIsUnmodified:true,actualDraftPixels:0,controlledFile:file,pass:true})
    } else if (name === 'node-modal-queued-close') {
      state.phase = 'another actual modal consumer retains its new opening across an old native close event'
      await waitStats(page,5,6);await quiet(page);await badge(page,0)
      await page.click('[data-testid="node-picker"]');await page.waitForSelector(NODE_RPC,{visible:true})
      const before=await page.$eval(NODE_RPC,input=>input.value)
      const transition=await reopenBeforeNativeClose(page,'node')
      assert.equal(transition.closedBeforeReopen,true);assert.equal(transition.reopenedBeforeEvent,true)
      assert.equal(transition.nativeEvent.trusted,true);assert.equal(transition.nativeEvent.targetMatches,true)
      assert.equal(transition.nativeEvent.openAtEvent,true);assert.equal(transition.openAfterEvent,true);assert.equal(transition.sameElement,true)
      await page.waitForSelector(NODE_RPC,{visible:true});assert.equal(await page.$eval(NODE_RPC,input=>input.value),before)
      assert.equal(await page.$eval(NODE_RPC,input=>document.activeElement===input),true)
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
      await waitStats(page,5,6);await badge(page,0)
      results.push({case:name,actualNodePickerModalConsumer:true,actualProductDOMCloseAndNodePickerReopen:true,
        actualSameNativeElementReopenedBeforeQueuedClose:true,actualTrustedQueuedCloseObserved:true,
        actualCurrentNativeEscapeStillCloses:true,actualNodeInputAndCurrentBoardPreserved:true,
        actualNativeDialogAndProductAPIsUnmodified:true,actualDraftPixels:0,actualReopenedNodeFocusAtEndpoint:true,transition,pass:true})

    } else if (name === 'image-alpha-count') {
      state.phase = 'actual PNG alpha bytes and preview-only scalar count'
      await imageReady(page)
      const file=await page.evaluate(async()=>{
        const canvas=document.createElement('canvas');canvas.width=4;canvas.height=2
        const alpha=[0,127,128,255,0,127,128,255],bytes=new Uint8ClampedArray(32)
        for(let i=0;i<8;i++){bytes[i*4]=240;bytes[i*4+1]=12;bytes[i*4+2]=34;bytes[i*4+3]=alpha[i]}
        canvas.getContext('2d').putImageData(new ImageData(bytes,4,2),0,0)
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))
        if(!blob)throw new Error('The native alpha PNG encoder returned no file')
        const file=new File([blob],'alpha-count.png',{type:'image/png'}),transfer=new DataTransfer();transfer.items.add(file)
        const input=document.querySelector('dialog[open] [data-testid="image-input"]')
        if(!input)throw new Error('The actual import input is unavailable')
        input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))
        return {name:file.name,type:file.type,bytes:file.size,encodedAlpha:alpha}
      })
      await smallImage(page)
      state.phase = 'actual displayed alpha-filtered count before stamp'
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('dialog[open] p')).some(p=>p.textContent.trim().startsWith('4 pixels.')))
      await page.click('[data-testid="as-stamp"]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
      const box=await(await page.$('[data-testid="board"]')).boundingBox();assert.ok(box)
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await badge(page,4)
      results.push({case:name,actualNativePNGFileWithControlledAlphaBytes:true,actualFileInputChangeAndRangeKeyboard:true,
        actualDisplayedPixels:4,actualPlacedDraftPixels:4,actualScaledStampDimensions:[4,2],
        actualDefaultHalfOpacityThresholdPreserved:true,actualNativeCanvasAndProductAPIsUnmodified:true,
        actualNoWalletOrChainSend:true,controlledFile:file,pass:true})
    } else if (name === 'image-stamp-overlap') {
      await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
      await showImageImport(page)
      const file = await chooseImage(page, {name: 'edge-stamp.png', png: true})
      await smallImage(page)
      await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog[open] p'))
        .some(node => node.textContent.trim().startsWith('8 pixels.')))
      await page.click('[data-testid="as-stamp"]')
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      state.phase = 'actual pointer over the right-edge stamp origin'
      const box = await (await page.$('[data-testid="board"]')).boundingBox()
      assert.ok(box && box.width > 100 && box.height > 100)
      const x = box.x + box.width - 12, y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.waitForFunction(() => document.querySelector('[data-testid="hud"]')
        ?.textContent.trim().startsWith('998, 500'))
      await page.mouse.click(x, y)
      await badge(page, 4)
      state.phase = 'actual saved draft coordinates and colours after edge placement'
      const indexes = [500998, 500999, 501998, 501999]
      const expected = indexes.flatMap(index => draftBytes(index, 0xff0000))
      const key = draftKey(13370)
      await untilAsync(async () => (await keeper.read(key)).length === expected.length,
        'The four in-board stamp pixels must reach the native draft store')
      const saved = await keeper.read(key)
      assert.deepEqual(saved, expected)
      results.push({case: name, actualNativePNGAndPointerPlacement: true, controlledFile: file,
        actualRightEdgeAnchor: [998, 500], actualDisplayedPixels: 8, actualPlacedDraftPixels: 4,
        actualSavedDraftBytes: saved, actualExpectedDraftIndexes: indexes, pass: true})
    } else if (name === 'image-tall-preview') {
      state.phase = 'bounded native SVG preview with an aspect-limited width range'
      await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
      await showImageImport(page)
      const file = await page.evaluate(() => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4000" viewBox="0 0 4 4000"><rect width="4" height="4000" fill="red"/></svg>'
        const image = new File([svg], 'tall.svg', {type: 'image/svg+xml'})
        const transfer = new DataTransfer(); transfer.items.add(image)
        const input = document.querySelector('dialog[open] [data-testid="image-input"]')
        input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles: true}))
        return {name: image.name, type: image.type, bytes: image.size}
      })
      assert.ok(file.bytes > 0 && file.bytes <= 1024)
      await page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent.includes('1 x 1000 px'))
      await page.waitForFunction(() => {
        const canvas = document.querySelector('dialog[open] canvas')
        return canvas?.width === 1 && canvas.height === 240
      })
      const range = await page.$eval('[data-testid="image-width"]', input => [input.min, input.max, input.value].map(Number))
      const preview = await page.$eval('dialog[open] canvas', canvas => ({
        dimensions: [canvas.width, canvas.height],
        rgba: Array.from(canvas.getContext('2d').getImageData(0, 120, 1, 1).data),
      }))
      const displayed = await page.$eval('dialog[open]', dialog => {
        const text = Array.from(dialog.querySelectorAll('p')).find(node => node.textContent.includes('pixels.'))?.textContent
        return Number(text?.split('pixels.')[0].replace(/[^0-9]/g, ''))
      })
      assert.deepEqual(range, [1, 1, 1]); assert.deepEqual(preview, {dimensions: [1, 240], rgba: [255, 0, 0, 255]})
      assert.equal(displayed, 1000)
      await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      await badge(page, 0)
      results.push({case: name, actualNativeTallSVGFileAndInput: true, controlledFile: file,
        actualSourceDimensions: [4, 4000], actualPictureDimensions: [1, 1000], actualWidthRange: range,
        actualPreview: preview, actualDisplayedPixels: displayed, actualDraftPixels: 0, pass: true})
    } else if (name === 'image-paste-svg') {
      state.phase = 'actual paste handler with controlled clipboard event data'
      await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
      const session = await page.createCDPSession(), urls = new Set()
      await session.send('Network.enable')
      session.on('Network.requestWillBeSent', event => {
        if (event.request.url.startsWith('blob:' + origin + '/')) urls.add(event.request.url)
      })
      const picker = page.waitForFileChooser({timeout: 1500}).then(async chooser => {
        await chooser.cancel(); return true
      }, error => {
        if (error.name !== 'TimeoutError') throw error
        return false
      })
      const observed = await page.evaluate(() => {
        const board = document.querySelector('[data-testid="board"]')
        const text = new DataTransfer(); text.setData('text/plain', 'Controlled text')
        const textOnly = new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: text})
        board.dispatchEvent(textOnly)
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 4 2"><rect width="4" height="2" fill="red"/></svg>'
        const file = new File([svg], 'pasted.svg', {type: 'image/svg+xml'})
        const mixed = new DataTransfer(); mixed.setData('text/plain', 'Controlled text')
        mixed.items.add(new File(['Controlled bytes'], 'ignored.txt', {type: 'text/plain'})); mixed.items.add(file)
        const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: mixed})
        board.dispatchEvent(event)
        return {textPrevented: textOnly.defaultPrevented, imagePrevented: event.defaultPrevented,
          eventTrusted: event.isTrusted, itemCount: event.clipboardData.items.length,
          controlledFile: {name: file.name, type: file.type, bytes: file.size}}
      })
      assert.equal(observed.textPrevented, false); assert.equal(observed.imagePrevented, true)
      assert.equal(observed.eventTrusted, false); assert.equal(observed.itemCount, 3)
      assert.ok(observed.controlledFile.bytes > 0 && observed.controlledFile.bytes <= 1024)
      await smallImage(page); assert.equal(await picker, false)
      await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog[open] p'))
        .some(node => node.textContent.trim().startsWith('8 pixels.')))
      const rgba = await page.$eval('dialog[open] canvas', canvas => Array.from(canvas.getContext('2d')
        .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data))
      assert.deepEqual(rgba, [255, 0, 0, 255])
      const url = await onlyImageURL({urls}); assert.equal(await canReadImageURL(page, url), true)
      await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      assert.equal(await canReadImageURL(page, url), false); await badge(page, 0)
      results.push({case: name, actualBrowserClipboardEvent: true, syntheticClipboardFixture: true,
        systemClipboardAccessed: false, actualPasteImportRendered: true, actualUnwantedNativeFileChoosers: 0,
        actualFileChooserObservationWindowMs: 1500, actualDisplayedPixels: 8, actualPreviewRGBA: rgba,
        actualSourceURLReleasedOnClose: true, actualDraftPixels: 0, ...observed, pass: true})
    } else if (name === 'image-source-budget') {
      state.phase = 'source byte rejection before native decode'
      const f = await imageReady(page)
      const sourceFile = await page.evaluate(() => {
        const chunk = new Blob([new Uint8Array(1024 * 1024)])
        const file = new File([...Array(32).fill(chunk), new Uint8Array(1)], 'over-byte-limit.svg')
        const input = document.querySelector('dialog[open] [data-testid="image-input"]')
        const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
        input.dispatchEvent(new Event('change', {bubbles: true}))
        return {name: file.name, type: file.type, bytes: file.size}
      })
      assert.equal(sourceFile.bytes, 32 * 1024 * 1024 + 1)
      await page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent.includes('Choose an image of 32 MiB or less.'))
      await quietExceptHeld(page); assert.equal(f.urls.size, 0)
      assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'), null)
      state.phase = 'oversized PNG header before native decoding'
      const width = 4001, height = 4000, encoded = budgetPNG(width, height)
      assert.ok(encoded.length > 0 && encoded.length <= 8192)
      const rasterFile = await page.evaluate(encoded => {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
        const file = new File([bytes], 'over-pixel-limit.png', {type: 'image/png'})
        const input = document.querySelector('dialog[open] [data-testid="image-input"]')
        const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
        input.dispatchEvent(new Event('change', {bubbles: true}))
        return {name: file.name, type: file.type, bytes: file.size}
      }, encoded.toString('base64'))
      assert.equal(rasterFile.bytes, encoded.length)
      await page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent.includes('Choose a raster image with 16 million pixels or fewer.'))
      assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'), null)
      await quietExceptHeld(page); assert.equal(f.urls.size, 0)
      state.phase = 'oversized GIF logical screen before native decoding'
      await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      await showImageImport(page)
      const gif = gifWithScreen(width, height)
      const gifFile = await page.evaluate(encoded => {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
        const file = new File([bytes], 'over-screen-limit.gif', {type: 'image/gif'})
        const input = document.querySelector('dialog[open] [data-testid="image-input"]')
        const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files
        input.dispatchEvent(new Event('change', {bubbles: true}))
        return {name: file.name, type: file.type, bytes: file.size}
      }, gif.toString('base64'))
      assert.equal(gifFile.bytes, gif.length)
      await page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent.includes('Choose a raster image with 16 million pixels or fewer.'))
      await quietExceptHeld(page); assert.equal(f.urls.size, 0)
      assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'), null)
      const rejectEncoded = async (encoded, name, type, total = encoded.length) => {
        state.phase = 'oversized ' + type + ' header before native decoding'
        await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
        await showImageImport(page)
        const file = await chooseEncodedImage(page, encoded, name, type, total)
        assert.equal(file.bytes, total)
        await page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent.includes('Choose a raster image with 16 million pixels or fewer.'))
        await quietExceptHeld(page); assert.equal(f.urls.size, 0)
        assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'), null)
        return file
      }
      const jpeg = budgetJPEG(width, height)
      assert.ok(jpeg.length <= 65536)
      const jpegFile = await rejectEncoded(jpeg, 'over-frame-limit.jpg', 'image/jpeg')
      const frame = Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'))
        if (blob?.type !== 'image/webp' || blob.size > 4096) throw new Error('Small native WebP encoding failed')
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      }))
      assert.equal(frame.toString('ascii', 0, 4), 'RIFF'); assert.equal(frame.toString('ascii', 8, 12), 'WEBP')
      let imageChunk
      for (let offset = 12; offset + 8 <= frame.length;) {
        const size = frame.readUInt32LE(offset + 4)
        const end = offset + 8 + size + size % 2
        assert.ok(end <= frame.length)
        if (['VP8 ', 'VP8L'].includes(frame.toString('ascii', offset, offset + 4))) {
          imageChunk = frame.subarray(offset, end); break
        }
        offset = end
      }
      assert.ok(imageChunk)
      const frameHeader = Buffer.alloc(16); frameHeader[12] = 100
      const animated = webpFile([webpCanvas(width, height, 2), webpChunk('ANIM', Buffer.alloc(6)),
        webpChunk('ANMF', Buffer.concat([frameHeader, imageChunk]))])
      const webpFileResult = await rejectEncoded(animated, 'over-canvas-limit.webp', 'image/webp')
      const bmp = budgetBMP(width, -height)
      const bmpFile = await rejectEncoded(bmp.header, 'over-bitmap-limit.bmp', 'image/bmp', bmp.total)
      const avif = readFileSync('test/fixtures/budget-large.avif')
      const avifFile = await rejectEncoded(avif, 'over-primary-limit.avif', 'image/avif')
      const acceptEncoded = async (encoded, name, type, total = encoded.length) => {
        state.phase = 'valid ' + name + ' after encoded size errors'
        await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
        await showImageImport(page)
        const file = await chooseEncodedImage(page, encoded, name, type, total)
        await smallImage(page)
        await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog[open] p'))
          .some(node => node.textContent.trim().startsWith('8 pixels.')))
        return file
      }
      const tinyBMP = budgetBMP(4, -2)
      const acceptedBMP = await acceptEncoded(tinyBMP.header, 'after-limit.bmp', 'image/bmp', tinyBMP.total)
      const acceptedAVIF = await acceptEncoded(readFileSync('test/fixtures/budget-small.avif'), 'after-limit.avif', 'image/avif')
      const acceptedICO = await acceptEncoded(smallIcon(false), 'after-limit.ico', '')
      const acceptedCUR = await acceptEncoded(smallIcon(true), 'after-limit.cur', '')
      state.phase = 'valid small JPEG from the same generator'
      const acceptedJPEG = await chooseEncodedImage(page, budgetJPEG(4, 2), 'after-limit.jpg', 'image/jpeg')
      await smallImage(page)
      await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog[open] p'))
        .some(node => node.textContent.trim().startsWith('8 pixels.')))
      state.phase = 'small native PNG follows the valid JPEG selection'
      const accepted = await chooseImage(page, {name: 'after-limit.png', png: true})
      await smallImage(page)
      await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog[open] p'))
        .some(node => node.textContent.trim().startsWith('8 pixels.')))
      const text = await page.$eval('dialog[open]', node => node.textContent)
      assert.ok(!text.includes('or less.') && !text.includes('or fewer.'))
      await page.click('dialog[open] button[title="Close"]'); await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      await badge(page, 0)
      results.push({case: name, actualFileInputSelections: 13, byteLimitFile: sourceFile,
        actualByteLimitErrorBeforeURLRequest: true, actualOversizedRasterFile: rasterFile,
        actualRasterFixtureDimensions: [width, height], actualPNGHeaderErrorBeforeURLRequest: true,
        actualGIFScreenFile: gifFile, actualGIFScreenDimensions: [width, height],
        actualGIFHeaderErrorBeforeURLRequest: true, actualJPEGFile: jpegFile, actualJPEGFrameDimensions: [width, height],
        actualJPEGHeaderErrorBeforeURLRequest: true, actualWebPFile: webpFileResult, actualWebPCanvasDimensions: [width, height],
        actualWebPHeaderErrorBeforeURLRequest: true, actualSmallJPEGRecovery: acceptedJPEG, actualSmallPNGRecovery: accepted,
        actualBMPFile: bmpFile, actualBMPDimensions: [width, height], actualBMPHeaderErrorBeforeURLRequest: true,
        actualAVIFFile: avifFile, actualAVIFPrimaryDimensions: [4002, 4000], actualAVIFHeaderErrorBeforeURLRequest: true,
        actualSmallBMPRecovery: acceptedBMP, actualSmallAVIFRecovery: acceptedAVIF,
        actualSmallICORecovery: acceptedICO, actualSmallCURRecovery: acceptedCUR,
        actualDisplayedPixelsAfterRecovery: 8, actualDraftPixels: 0, pass: true})
    } else if (name === 'image-transfer-budget') {
      state.phase = 'actual file drop and clipboard raster admission'
      await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
      const session = await page.createCDPSession(), urls = new Set()
      await session.send('Network.enable'); await session.send('Page.enable')
      let pickerCount = 0
      session.on('Network.requestWillBeSent', event => {
        if (event.request.url.startsWith('blob:' + origin + '/')) urls.add(event.request.url)
      })
      session.on('Page.fileChooserOpened', () => { pickerCount++ })
      await session.send('Page.setInterceptFileChooserDialog', {enabled: true})
      const handles = []
      const file = async (...args) => {
        const handle = await transferFile(page, ...args)
        handles.push(handle)
        return handle
      }
      const waitClosed = () => page.waitForFunction(() => !document.querySelector('dialog[open]'))
      const closeImage = async () => {
        await page.click('dialog[open] button[title="Close"]')
        await waitClosed()
      }
      const transfer = async (route, value, options) => {
        const seen = await boardTransfer(page, route, value, options)
        assert.equal(seen.defaultPrevented, true)
        assert.equal(seen.dragOverPrevented, route === 'drop' ? true : null)
        return seen
      }
      try {
        const text = await boardTransfer(page, 'drop', null)
        const unsupported = await boardTransfer(page, 'drop', null, {mixed: true})
        const pasteText = await boardTransfer(page, 'paste', null, {mixed: true})
        assert.deepEqual([text.dragOverPrevented, text.defaultPrevented], [false, false])
        assert.deepEqual([unsupported.dragOverPrevented, unsupported.defaultPrevented], [true, true])
        assert.equal(pasteText.defaultPrevented, false)
        await quietExceptHeld(page)
        assert.equal(await page.$('dialog[open]'), null); assert.equal(urls.size, 0)

        const overBytes = await file(Buffer.alloc(0), 'over-transfer-byte-limit.bmp', '', 32 * 1024 * 1024 + 1)
        const bmp = budgetBMP(4001, -4000), small = budgetBMP(4, -2)
        const overBMP = await file(bmp.header, 'over-transfer-bitmap-limit.bmp', '', bmp.total)
        const overAVIF = await file(readFileSync('test/fixtures/budget-large.avif'), 'over-transfer-primary-limit.avif')
        const tinyBMP = await file(small.header, 'transfer-recovery.bmp', '', small.total)
        const tinyAVIF = await file(readFileSync('test/fixtures/budget-small.avif'), 'transfer-recovery.avif')
        const byteErrors = [], pixelErrors = [], pendingCloses = [], recoveries = []
        const reject = async (route, value, message) => {
          const seen = await transfer(route, value, {mixed: true})
          await page.waitForFunction(message => document.querySelector('dialog[open]')?.textContent.includes(message), {}, message)
          assert.equal(await page.$('dialog[open] [data-testid="as-stamp"]'), null)
          await quietExceptHeld(page); assert.equal(urls.size, 0)
          await closeImage()
          return seen
        }
        for (const [route, large, valid] of [['drop', overBMP, tinyBMP], ['paste', overAVIF, tinyAVIF]]) {
          state.phase = route + ' source byte and raster pixel limits'
          byteErrors.push(await reject(route, overBytes, 'Choose an image of 32 MiB or less.'))
          pixelErrors.push(await reject(route, large, 'Choose a raster image with 16 million pixels or fewer.'))
          state.phase = route + ' closes before a raster preview can publish'
          pendingCloses.push(await transfer(route, valid, {mixed: true, closeNow: true}))
          await waitClosed(); await quietExceptHeld(page)
          assert.equal(urls.size, 0)
        }
        for (const [route, valid] of [['drop', tinyBMP], ['paste', tinyAVIF]]) {
          state.phase = route + ' reopens with a valid raster preview'
          const seen = await transfer(route, valid, {mixed: true})
          await smallImage(page)
          await page.waitForFunction(() => Array.from(document.querySelectorAll('dialog[open] p'))
            .some(node => node.textContent.trim().startsWith('8 pixels.')))
          await onlyImageURL({urls}, recoveries.length + 1)
          recoveries.push({...seen, pixels: 8})
          await closeImage()
        }
        await quietExceptHeld(page); await badge(page, 0)
        assert.equal(pickerCount, 0); assert.equal(urls.size, 2)
        results.push({case: name, textDrop: text, unsupportedFileDrop: unsupported, nonImagePaste: pasteText,
          byteErrors, pixelErrors, pendingCloses, recoveries, actualSourceURLRequestsBeforeRecovery: 0,
          actualSourceURLRequestsForRecovery: urls.size, actualUnwantedNativeFileChoosers: pickerCount,
          controlledDragAndClipboardEvents: true, actualDraftPixels: 0, pass: true})
      } finally {
        await session.send('Page.setInterceptFileChooserDialog', {enabled: false})
        await Promise.all(handles.map(handle => handle.dispose()))
      }
    } else if (name === 'modal-focus-keyboard') {
      state.phase = 'shared dialog names and independent desktop and mobile labels'
      await waitStats(page, 5, 6); await quiet(page); await badge(page, 0)
      const session = await page.createCDPSession()
      await session.send('DOM.enable')
      await session.send('Accessibility.enable')
      const associations = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('dialog.mozaic-dialog')]
        const names = dialogs.map(dialog => {
          const heading = dialog.querySelector('h2')
          if (!heading?.id || dialog.getAttribute('aria-labelledby') !== heading.id) throw new Error('Missing dialog title association')
          return heading.textContent.trim()
        }).sort()
        const fields = [...document.querySelectorAll('[data-testid="node-rpc"], [data-testid="node-contract"]')]
        const labels = fields.map(input => {
          const label = input.labels?.item(0)
          if (!input.id || label?.control !== input || label.closest('dialog') !== input.closest('dialog')) {
            throw new Error('A node field does not own its label')
          }
          return label.textContent.trim()
        }).sort()
        const ids = [...dialogs.map(dialog => dialog.querySelector('h2').id), ...fields.map(input => input.id)]
        return {names, labels, distinctIds: new Set(ids).size, totalIds: ids.length}
      })
      assert.deepEqual(associations.names, ['Account', 'Bring in an image', 'Connect a wallet', 'Keyboard', 'Node and canvas', 'Node and canvas'])
      assert.deepEqual(associations.labels, ['JSON-RPC endpoint', 'JSON-RPC endpoint', 'Mozaic contract', 'Mozaic contract'])
      assert.equal(associations.distinctIds, associations.totalIds); assert.equal(associations.totalIds, 10)

      state.phase = 'node keyboard entry and forward and backward focus'
      const node = '[data-testid="node-picker"]'
      const help = 'button[title="Keyboard shortcuts (?)"]'
      const focused = () => page.evaluate(() => {
        const el = document.activeElement
        return el?.getAttribute('data-testid') || el?.getAttribute('title') || ''
      })
      const waitFocus = selector => page.waitForFunction(selector => document.activeElement?.matches(selector), {}, selector)
      const tabBackward = async () => {
        await page.keyboard.down('Shift')
        try {await page.keyboard.press('Tab')}
        finally {await page.keyboard.up('Shift')}
      }
      const axNames = []
      await page.focus(node); await page.keyboard.press('Enter')
      await waitFocus(NODE_RPC)
      const nodeInitialFocus = await focused()
      axNames.push(await dialogAccessibleName(page, session, 'Node and canvas'))
      await tabBackward()
      const nodeBack = await focused()
      await page.keyboard.press('Tab')
      const nodeForward = await focused()
      assert.deepEqual([nodeInitialFocus, nodeBack, nodeForward], ['node-rpc', 'Close', 'node-rpc'])
      await page.keyboard.press('Escape')
      await waitFocus(node)
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))

      state.phase = 'keyboard help initial focus and accessible name'
      await page.focus(help); await page.keyboard.press('Enter')
      await waitFocus('dialog[open] button[title="Close"]')
      axNames.push(await dialogAccessibleName(page, session, 'Keyboard'))
      state.phase = 'paste opens the image preview above keyboard help'
      const paste = await page.evaluate(() => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="red"/></svg>'
        const file = new File([svg], 'focus-stack.svg', {type: 'image/svg+xml'})
        const data = new DataTransfer()
        data.items.add(file)
        const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data})
        document.activeElement.dispatchEvent(event)
        return {prevented: event.defaultPrevented, bytes: file.size}
      })
      assert.equal(paste.prevented, true)
      await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 2 &&
        document.querySelector('dialog[open] [data-testid="as-stamp"]') !== null)
      axNames.push(await dialogAccessibleName(page, session, 'Bring in an image'))
      const imageFocus = () => page.evaluate(() => document.activeElement?.closest('dialog')?.querySelector('h2')?.textContent.trim())
      assert.equal(await imageFocus(), 'Bring in an image')
      state.phase = 'top dialog Tab and Home set the preview width'
      const imageInitial = await focused()
      await page.keyboard.press('Tab')
      const imageForward = await focused()
      assert.equal(imageForward, 'image-width')
      await page.keyboard.press('Home')
      const widthAfterHome = await page.$eval('dialog[open] [data-testid="image-width"]', input => input.valueAsNumber)
      assert.equal(widthAfterHome, 4)
      await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] p')]
        .some(node => node.textContent.trim().startsWith('8 pixels.')))
      await tabBackward()
      const imageBack = await focused()
      assert.deepEqual([imageInitial, imageForward, imageBack], ['Close', 'image-width', 'Close'])
      state.phase = 'the lower dialog and page are inert'
      const inert = await page.evaluate(help => {
        const active = document.activeElement
        const lower = [...document.querySelectorAll('dialog[open]')].find(el => el.querySelector('h2')?.textContent.trim() === 'Keyboard')
        lower.querySelector('button[title="Close"]').focus()
        const lowerInert = document.activeElement === active
        document.querySelector(help).focus()
        return {lowerInert, pageInert: document.activeElement === active}
      }, help)
      assert.deepEqual(inert, {lowerInert: true, pageInert: true})
      state.phase = 'top Escape restores keyboard help focus'
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 1 &&
        document.activeElement?.getAttribute('title') === 'Close' &&
        document.activeElement?.closest('dialog')?.querySelector('h2')?.textContent.trim() === 'Keyboard')
      state.phase = 'lower Escape restores invoker focus'
      await page.keyboard.press('Escape')
      await waitFocus(help)
      await page.waitForFunction(() => !document.querySelector('dialog[open]'))
      await quiet(page); await badge(page, 0)
      results.push({case: name, associations, actualChromiumAccessibleNames: axNames,
        actualNodeFocusSequence: [nodeInitialFocus, nodeBack, nodeForward], actualNodeFocusRestored: true,
        actualImageFocusSequence: [imageInitial, imageForward, imageBack], actualModalInertness: inert,
        actualTopEscapeRestoredLowerFocus: true, actualLowerEscapeRestoredInvoker: true,
        controlledClipboardFixture: paste, actualKeyboardHomeSetWidth: widthAfterHome, actualNestedPreviewPixels: 8, actualDraftPixels: 0, pass: true})
    } else {
      await waitStats(page, 5, 6); await quiet(page); await changeNode(page, '')
      await page.waitForFunction(() => {const rows = Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim()); return rows[0] === '-' && rows[2] === '-'})
      results.push({case: name, observedUnavailableStats: await stats(page), pass: true})
    }
    assert.equal(unexpected.length, unexpectedStart); assert.deepEqual(errors.slice(errorStart), [])
    const result = {...results.at(-1), source, actualProductionBundleAndVueDOM: true, controlledLoopbackRPC: true, walletProviderOrPublicNetwork: false, actualProductPageVisibility: await page.evaluate(() => document.visibilityState)}
    assert.equal(result.actualProductPageVisibility, 'visible')
    console.log('MOZAIC-BOARD-BROWSER ' + JSON.stringify(result))
    } catch (error) {
      results.length = caseStart
      const failure = await failureDetail(error, state, page); failures.push(failure)
      console.log('MOZAIC-BOARD-BROWSER-FAILURE ' + JSON.stringify(failure))
    } finally {
      for (const row of state.held.values()) if (!row.released) row.release()
      if (keeper) {
        try {const closed = await keeper.unlockIfHeld(); assert.ok(!closed.timedOut)}
        catch (error) {const failure = {case: name, source, phase: 'native fixture cleanup', errorType: error.name, message: String(error.message).slice(0, 240)}; failures.push(failure); console.log('MOZAIC-BOARD-BROWSER-FAILURE ' + JSON.stringify(failure))}
      }
      await context.close()
    }
  }
  console.log('MOZAIC-BOARD-BROWSER-AGGREGATE ' + JSON.stringify({source, attempted: results.length + failures.length, passed: results.length, failures}))
  assert.deepEqual(failures, [], 'All independent production scenarios must pass')
  assert.equal(results.length, 38); assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
  assert.ok(delivered.has('index.html') && Array.from(delivered.keys()).some(name => name.endsWith('.js')))
  console.log('MOZAIC-BOARD-BROWSER-SUMMARY ' + JSON.stringify({schema: 1, source, cases: results.length, passed: results.length, failed: 0,
    browserVersion, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    actualProductPageVisibility: 'visible', independentScenarioFailuresCollectedBeforeFinalVerdict: true,
    actualProductionEntryRoutes: ['canvas', 'gallery'], actualDraftPixelsPreserved: 1, actualIndexedDBAndLegacyStorage: true, nativeStorageLockCases: 4, actualDraftReloadCases: 2, actualSharedDraftRecoveryCases: 1, actualPixelDetailCases: 5, stationaryPointerDetailCases: 2, actualGestureAndNavigationCases: 5, actualTouchInputCases: 3, actualRouteTimerBoundaryCases: 1, actualSmallCanvasCases: 1, actualImageImportCases: 14, actualImageBudgetCases: 1, actualImageTransferBudgetCases: 1, actualBrowserClipboardEventCases: 3, actualNativePictureSizeCases: 1, actualNativeAlphaCountCases: 1, actualNativeStampOverlapCases: 1, actualNativeFileDropCases: 4, actualNativeModalCases: 4, actualModalFocusKeyboardCases: 1, actualQueuedModalCloseCases: 2, actualNativeEscapeCases: 5, actualNativePNGPlacementCases: 3, actualNativeSVGResourceCases: 5, actualExplicitObjectURLLifetimeCases: 6, actualPendingImportCloseCases: 2,
    servedBuildFiles: Object.fromEntries(Array.from(delivered).sort()), unexpectedExternalRequests: 0, pageOrFixtureErrors: 0,
    walletProvidersConnected: 0, publicNetworkOrRealNoMExecution: false, sourceTestHooksOrProductModuleReplacements: 0}))
} catch (error) {
  console.log('MOZAIC-BOARD-BROWSER-RUN-FAILURE ' + JSON.stringify({case: active?.name, source,
    errorType: error.name, message: String(error.message).slice(0, 240),
    heldReplies: Array.from(active?.held ?? [], ([name, row]) => ({name, released: row.released === true})),
    RPCRequests: active?.calls.length, contractRequests: active?.contractCalls.length}))
  throw error
} finally {
  for (const row of active?.held.values() ?? []) if (!row.released) row.release()
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
