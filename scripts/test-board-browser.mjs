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
const TX = '0x' + 'd'.repeat(64), hash = '0x' + 'e'.repeat(64), zero = '0x' + '0'.repeat(64)
const hex = value => '0x' + BigInt(value).toString(16)
const topic = value => keccak256(toBytes(value)), addressTopic = address => '0x' + address.slice(2).padStart(64, '0')
const px = '0x000000112233'
const canvasPaint = {address: A, blockNumber: '0x9', transactionHash: TX, transactionIndex: '0x0', logIndex: '0x1', blockHash: hash, removed: false,
  topics: [topic('Painted(address,uint256,bytes)'), addressTopic(R)], data: encodeAbiParameters([{type: 'uint256'}, {type: 'bytes'}], [1n, px])}
const routerPaint = {address: R, blockNumber: '0x9', transactionHash: TX, transactionIndex: '0x0', logIndex: '0x0', blockHash: hash, removed: false,
  topics: [topic('PaintedBy(address,address,uint256)'), addressTopic(ARTIST), addressTopic(ARTIST)], data: encodeAbiParameters([{type: 'uint256'}], [1n])}
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
  const head = node === 'a' ? 10 : 20
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
      if (state.name === 'late-router' && node === 'a' && !state.held.has('router')) return hold(state, 'router', value)
      return value
    }
    if (functionName === 'WIDTH' || functionName === 'HEIGHT') return encode(abi, functionName, 1000n)
    if (functionName === 'price') return encode(abi, functionName, 100_000_000_000_000n)
    if (functionName === 'owner') return encode(abi, functionName, ARTIST)
    if (functionName === 'painted') {
      const value = encode(abi, functionName, second ? 7n : 5n)
      if (state.name === 'old-totals' && node === 'a' && !state.held.has('painted')) return hold(state, 'painted', value)
      return value
    }
    assert.equal(functionName, 'chunk')
    assert.equal(args[1], 10_000n)
    const colour = ['old-chunk', 'canvas-switch'].includes(state.name) ? (second ? 0x446688 : 0xff0000) : 0x112233
    const value = args[0] === 0n ? '0x00000000' + (BigInt(colour ^ 0xffffff)).toString(16).padStart(64, '0') : '0x'
    const encoded = encode(abi, functionName, value)
    if (['old-chunk', 'canvas-switch'].includes(state.name) && !second && args[0] === 0n && !state.held.has('chunk')) return hold(state, 'chunk', encoded)
    return encoded
  }
  if (call.method === 'eth_getLogs') {
    if (['old-history', 'old-log-error'].includes(state.name) && node === 'a' && !state.held.has('history')) return hold(state, 'history', [canvasPaint])
    const filter = call.params[0], from = Number(filter.fromBlock), to = Number(filter.toBlock)
    if (from > 9 || to < 9) return []
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
const results = []
async function stats(page) {return page.evaluate(() => Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim()))}
async function waitStats(page, painted, balance) {
  await page.waitForFunction((p, b) => {const rows = Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim())
    return Number(rows[0]?.replaceAll(',', '')) === p && Number(rows[2]?.replaceAll(',', '')) === b}, {timeout: 20_000}, painted, balance)
}
async function changeNode(page, url) {
  await page.click('[data-testid="node-picker"]')
  await page.waitForSelector('#rpc-url', {visible: true})
  await page.$eval('#rpc-url', (input, value) => {input.value = value; input.dispatchEvent(new Event('input', {bubbles: true}))}, url)
  await page.$eval('#rpc-url', input => input.closest('form').requestSubmit())
}
async function quiet(page) {await page.waitForNetworkIdle({idleTime: 250, timeout: 20_000}); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))}

const PIXEL = 500 * 1000 + 500
const draftKey = chain => `draft.${chain}.${A.toLowerCase()}`
const draftBytes = (index, rgb) => [index >> 16, index >> 8 & 255, index & 255, rgb >> 16, rgb >> 8 & 255, rgb & 255]
async function untilAsync(test, label) {const started = Date.now(); while (!await test()) {assert.ok(Date.now() - started < 20_000, label); await later(30)}}
async function badge(page, count) {
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

try {
  browser = await puppeteer.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run']})
  const browserVersion = await browser.version()
  for (const name of ['old-head', 'old-totals', 'late-router', 'unavailable', 'old-chunk', 'old-history', 'old-log-error', 'canvas-switch', 'draft-context', 'draft-fast-return', 'draft-storage-reload', 'legacy-storage-migration']) {
    active = {name, held: new Map(), calls: [], contractCalls: []}; const state = active
    const context = await browser.createBrowserContext(), page = await context.newPage()
    page.setDefaultTimeout(20_000); await page.setViewport({width: 1440, height: 1000})
    page.on('pageerror', error => errors.push(String(error)))
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = request.url()
      if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) void request.continue()
      else {unexpected.push(new URL(url).origin); void request.abort('blockedbyclient')}
    })
    let keeper, legacyValue
    if (['draft-context', 'draft-fast-return', 'draft-storage-reload', 'legacy-storage-migration'].includes(name)) {
      const seeds = {[draftKey(13370)]: name === 'draft-context' || name === 'draft-fast-return' ? draftBytes(1, 0xff0000) : [],
        [draftKey(13371)]: name === 'draft-context' ? draftBytes(2, 0x00ff00) : []}
      keeper = await storageKeeper(context, seeds)
      if (name === 'draft-context') await keeper.lock()
      if (name === 'legacy-storage-migration') {legacyValue = Buffer.from(draftBytes(1, 0xff0000)).toString('hex'); await keeper.legacy(draftKey(13370), legacyValue); await keeper.lock('readonly')}
    }
    const query = new URLSearchParams({rpc: origin + '/node/a/rpc', contract: A, x: '0', y: '0', z: '8', ...(name === 'late-router' ? {router: R} : {})})
    await page.goto(origin + base + '?' + query, {waitUntil: 'domcontentloaded'})
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
      await waitStats(page, 7, 8); await quiet(page)
      const before = await canvasColour(page); assert.deepEqual(before, [68, 102, 136])
      state.held.get('chunk').release(); await quiet(page)
      const after = await canvasColour(page); assert.deepEqual(after, before)
      const chunks = state.contractCalls.filter(row => row.functionName === 'chunk' && (name === 'canvas-switch' ? row.to.toLowerCase() === B : row.node === 'b')).length
      assert.equal(chunks, 10)
      results.push({case: name, originalChunkHeldAndReleased: true, actualCurrentCanvasRGBBefore: before, actualCurrentCanvasRGBAfter: after,
        currentSnapshotChunks: chunks, actualNodeOrCanvasPickerUsed: true, observedStats: await stats(page), pass: true})
    } else if (name === 'old-history' || name === 'old-log-error') {
      await until(() => state.held.has('history'), 'The original A history request must actually be held')
      await changeNode(page, origin + '/node/b/rpc'); await waitStats(page, 7, 8); await quiet(page)
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
    } else {
      await waitStats(page, 5, 6); await quiet(page); await changeNode(page, '')
      await page.waitForFunction(() => {const rows = Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim()); return rows[0] === '-' && rows[2] === '-'})
      results.push({case: name, observedUnavailableStats: await stats(page), pass: true})
    }
    assert.equal(unexpected.length, 0); assert.deepEqual(errors, [])
    const result = {...results.at(-1), source, actualProductionBundleAndVueDOM: true, controlledLoopbackRPC: true, walletProviderOrPublicNetwork: false}
    console.log('MOZAIC-BOARD-BROWSER ' + JSON.stringify(result)); await context.close()
  }
  assert.equal(results.length, 12); assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
  assert.ok(delivered.has('index.html') && Array.from(delivered.keys()).some(name => name.endsWith('.js')))
  console.log('MOZAIC-BOARD-BROWSER-SUMMARY ' + JSON.stringify({schema: 1, source, cases: 12, passed: 12, failed: 0,
    browserVersion, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    actualProductionEntryRoutes: ['canvas', 'gallery'], actualDraftPixelsPreserved: 1, actualIndexedDBAndLegacyStorage: true, nativeStorageLockCases: 3, actualDraftReloadCases: 1,
    servedBuildFiles: Object.fromEntries(Array.from(delivered).sort()), unexpectedExternalRequests: 0, pageOrFixtureErrors: 0,
    walletProvidersConnected: 0, publicNetworkOrRealNoMExecution: false, sourceTestHooksOrProductModuleReplacements: 0}))
} finally {
  for (const row of active?.held.values() ?? []) if (!row.released) row.release()
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
