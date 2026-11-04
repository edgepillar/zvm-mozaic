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
const A = '0x' + '1'.repeat(40), R = '0x' + '3'.repeat(40), ARTIST = '0x' + '4'.repeat(40)
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
    const value = node === 'a' ? hex(6n * 10n ** 18n) : hex(8n * 10n ** 18n)
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
      const value = encode(abi, functionName, node === 'a' ? 5n : 7n)
      if (state.name === 'old-totals' && node === 'a' && !state.held.has('painted')) return hold(state, 'painted', value)
      return value
    }
    assert.equal(functionName, 'chunk')
    assert.equal(args[1], 10_000n)
    const value = args[0] === 0n ? '0x00000000' + (BigInt(0x112233 ^ 0xffffff)).toString(16).padStart(64, '0') : '0x'
    return encode(abi, functionName, value)
  }
  if (call.method === 'eth_getLogs') {
    const filter = call.params[0], from = Number(filter.fromBlock), to = Number(filter.toBlock)
    if (from > 9 || to < 9) return []
    const addresses = [filter.address].flat().map(value => value.toLowerCase())
    return [...(addresses.includes(R.toLowerCase()) ? [routerPaint] : []), canvasPaint]
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
      const answer = async call => ({jsonrpc: '2.0', id: call.id, result: await rpc(state, match[1], call, batched)})
      response.end(JSON.stringify(batched ? await Promise.all(body.map(answer)) : await answer(body))); return
    }
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
try {
  browser = await puppeteer.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run']})
  const browserVersion = await browser.version()
  for (const name of ['old-head', 'old-totals', 'late-router', 'unavailable']) {
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
    const query = new URLSearchParams({rpc: origin + '/node/a/rpc', contract: A, ...(name === 'late-router' ? {router: R} : {})})
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
    } else {
      await waitStats(page, 5, 6); await quiet(page); await changeNode(page, '')
      await page.waitForFunction(() => {const rows = Array.from(document.querySelectorAll('.stats-body b'), node => node.textContent.trim()); return rows[0] === '-' && rows[2] === '-'})
      results.push({case: name, observedUnavailableStats: await stats(page), pass: true})
    }
    assert.equal(unexpected.length, 0); assert.deepEqual(errors, [])
    const result = {...results.at(-1), source, actualProductionBundleAndVueDOM: true, controlledLoopbackRPC: true, walletProviderOrPublicNetwork: false}
    console.log('MOZAIC-BOARD-BROWSER ' + JSON.stringify(result)); await context.close()
  }
  assert.equal(results.length, 4); assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
  assert.ok(delivered.has('index.html') && Array.from(delivered.keys()).some(name => name.endsWith('.js')))
  console.log('MOZAIC-BOARD-BROWSER-SUMMARY ' + JSON.stringify({schema: 1, source, cases: 4, passed: 4, failed: 0,
    browserVersion, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    actualProductionEntryRoutes: ['canvas', 'gallery'], actualDraftPixelsPreserved: 1,
    servedBuildFiles: Object.fromEntries(Array.from(delivered).sort()), unexpectedExternalRequests: 0, pageOrFixtureErrors: 0,
    walletProvidersConnected: 0, publicNetworkOrRealNoMExecution: false, sourceTestHooksOrProductModuleReplacements: 0}))
} finally {
  for (const row of active?.held.values() ?? []) if (!row.released) row.release()
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
