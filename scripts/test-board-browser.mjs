// Serve the existing production build to real Chrome with controlled loopback
// RPC replies. No product modules are replaced and no wallet is connected.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile, stat} from 'node:fs/promises'
import {existsSync, readFileSync} from 'node:fs'
import {resolve, extname} from 'node:path'
import {createHash} from 'node:crypto'
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
const IMAGE_CASES = ['image-stamp', 'image-close', 'image-replace-guide', 'image-close-pending', 'image-drop']
const MODAL_CASES = ['image-queued-close', 'image-native-escape', 'node-modal-queued-close']
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
  await page.waitForSelector('#rpc-url', {visible: true})
  await page.$eval('#rpc-url', (input, value) => {input.value = value; input.dispatchEvent(new Event('input', {bubbles: true}))}, url)
  await page.$eval('#rpc-url', input => input.closest('form').requestSubmit())
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
async function drawPixel(page) {
  await page.keyboard.press('b')
  const canvas = await page.$('[data-testid="board"]'), box = await canvas.boundingBox()
  assert.ok(box && box.width > 100 && box.height > 100)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
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
  await page.waitForSelector('#rpc-url', {visible: true})
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
  for (const name of ['old-head', 'old-totals', 'late-router', 'unavailable', 'old-chunk', 'old-history', 'old-log-error', 'canvas-switch', 'draft-context', 'draft-fast-return', 'draft-storage-reload', 'legacy-storage-migration', 'late-history-details', 'late-router-details', 'live-details', 'history-unavailable-details', 'unavailable-details', 'pointer-cancel', 'held-pointer-context', 'pinch-spray', 'deferred-route', 'view-dimensions', 'image-stamp', 'image-close', 'image-replace-guide', 'image-close-pending', 'image-drop', 'image-queued-close', 'image-native-escape', 'node-modal-queued-close']) {
    active = {name, held: new Map(), calls: [], contractCalls: []}; const state = active
    console.log('MOZAIC-BOARD-BROWSER-START ' + JSON.stringify({case: name, source}))
    const context = await browser.createBrowserContext(), page = await context.newPage()
    let keeper, legacyValue
    const caseStart = results.length, errorStart = errors.length, unexpectedStart = unexpected.length
    state.phase = 'setup'
    try {
    page.setDefaultTimeout(20_000); await page.setViewport({width: 1440, height: 1000})
    page.on('pageerror', error => errors.push(String(error)))
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = request.url()
      if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) void request.continue()
      else {unexpected.push(new URL(url).origin); void request.abort('blockedbyclient')}
    })
    if (['draft-context', 'draft-fast-return', 'draft-storage-reload', 'legacy-storage-migration'].includes(name)) {
      const seeds = {[draftKey(13370)]: name === 'draft-context' || name === 'draft-fast-return' ? draftBytes(1, 0xff0000) : [],
        [draftKey(13371)]: name === 'draft-context' ? draftBytes(2, 0x00ff00) : []}
      keeper = await storageKeeper(context, seeds)
      if (name === 'draft-context') await keeper.lock()
      if (name === 'legacy-storage-migration') {legacyValue = Buffer.from(draftBytes(1, 0xff0000)).toString('hex'); await keeper.legacy(draftKey(13370), legacyValue); await keeper.lock('readonly')}
    }
    const query = new URLSearchParams({rpc: origin + '/node/a/rpc', contract: A, x: (DETAIL_CASES.includes(name) || GESTURE_CASES.includes(name) || IMAGE_CASES.includes(name) || MODAL_CASES.includes(name)) ? '500' : '0', y: (DETAIL_CASES.includes(name) || GESTURE_CASES.includes(name) || IMAGE_CASES.includes(name) || MODAL_CASES.includes(name)) ? '500' : '0', z: '8', ...(['late-router', 'late-router-details'].includes(name) ? {router: R} : {})})
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
        await page.click('[data-testid="node-picker"]'); await page.waitForSelector('#contract', {visible: true})
        await page.$eval('#contract', (input, value) => {input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); input.closest('form').requestSubmit()}, B)
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
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
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
      results.push({case:name,actualNativeEscapeKey:true,actualCurrentEscapeClosesDialog:true,actualEscapeReleasesNativeSVGURL:true,
        actualFreshDropAndNativePreviewRecoverAfterEscape:true,actualNextCurrentCloseStillReleasesSource:true,
        actualNativeDialogAndProductAPIsUnmodified:true,actualDraftPixels:0,controlledFile:file,pass:true})
    } else if (name === 'node-modal-queued-close') {
      state.phase = 'another actual modal consumer retains its new opening across an old native close event'
      await waitStats(page,5,6);await quiet(page);await badge(page,0)
      await page.click('[data-testid="node-picker"]');await page.waitForSelector('#rpc-url',{visible:true})
      const before=await page.$eval('#rpc-url',input=>input.value)
      const transition=await reopenBeforeNativeClose(page,'node')
      assert.equal(transition.closedBeforeReopen,true);assert.equal(transition.reopenedBeforeEvent,true)
      assert.equal(transition.nativeEvent.trusted,true);assert.equal(transition.nativeEvent.targetMatches,true)
      assert.equal(transition.nativeEvent.openAtEvent,true);assert.equal(transition.openAfterEvent,true);assert.equal(transition.sameElement,true)
      await page.waitForSelector('#rpc-url',{visible:true});assert.equal(await page.$eval('#rpc-url',input=>input.value),before)
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
      await waitStats(page,5,6);await badge(page,0)
      results.push({case:name,actualNodePickerModalConsumer:true,actualProductDOMCloseAndNodePickerReopen:true,
        actualSameNativeElementReopenedBeforeQueuedClose:true,actualTrustedQueuedCloseObserved:true,
        actualCurrentNativeEscapeStillCloses:true,actualNodeInputAndCurrentBoardPreserved:true,
        actualNativeDialogAndProductAPIsUnmodified:true,actualDraftPixels:0,transition,pass:true})
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
  console.log('MOZAIC-BOARD-BROWSER-AGGREGATE ' + JSON.stringify({source, attempted: 30, passed: results.length, failures}))
  assert.deepEqual(failures, [], 'All independent production scenarios must pass')
  assert.equal(results.length, 30); assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
  assert.ok(delivered.has('index.html') && Array.from(delivered.keys()).some(name => name.endsWith('.js')))
  console.log('MOZAIC-BOARD-BROWSER-SUMMARY ' + JSON.stringify({schema: 1, source, cases: 30, passed: 30, failed: 0,
    browserVersion, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    actualProductPageVisibility: 'visible', independentScenarioFailuresCollectedBeforeFinalVerdict: true,
    actualProductionEntryRoutes: ['canvas', 'gallery'], actualDraftPixelsPreserved: 1, actualIndexedDBAndLegacyStorage: true, nativeStorageLockCases: 3, actualDraftReloadCases: 1, actualPixelDetailCases: 5, stationaryPointerDetailCases: 2, actualGestureAndNavigationCases: 5, actualTouchInputCases: 3, actualRouteTimerBoundaryCases: 1, actualSmallCanvasCases: 1, actualImageImportCases: 7, actualNativeFileDropCases: 3, actualNativeModalCases: 3, actualQueuedModalCloseCases: 2, actualNativeEscapeCases: 2, actualNativePNGPlacementCases: 1, actualNativeSVGResourceCases: 4, actualExplicitObjectURLLifetimeCases: 5, actualPendingImportCloseCases: 1,
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
