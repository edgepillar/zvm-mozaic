// Execute the shipped endpoint module with explicit memory-only Vue, fetch and
// storage capabilities. These controls do not start an SDK, browser or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {createContext, SourceTextModule, SyntheticModule} from 'node:vm'

const kind = 'mozaic'
const rpc = true
const source = readFileSync(new URL('../src/core/endpoint.ts', import.meta.url), 'utf8')
const CANVAS_A = '0x' + '1'.repeat(40), CANVAS_B = '0x' + '2'.repeat(40), OWNER = '0x' + '3'.repeat(40)
const ROUTER_A = '0x' + '4'.repeat(40), ROUTER_B = '0x' + '5'.repeat(40)
const alpha = 'http://alpha.invalid', beta = 'http://beta.invalid'
const urlOf = host => rpc ? host + '/rpc' : host
const selected = api => rpc ? api.endpoint.rpc : api.endpoint.url
const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve()}

// The sole parameter-property constructor is lowered explicitly for Node's
// strip-only API. An exact inverse protects every async and request expression.
function lowerErrorConstructor(value) {
  const before = "class HttpError extends Error {\n  constructor(\n    readonly status: number,\n    readonly statusText: string,\n  ) {\n    super(`${status} ${statusText}`)\n  }\n}", after = "class HttpError extends Error {\n  readonly status: number\n  readonly statusText: string\n  constructor(status: number, statusText: string) {\n    super(`${status} ${statusText}`)\n    this.status = status\n    this.statusText = statusText\n  }\n}"
  assert.equal(value.split(before).length - 1, 1)
  const lowered = value.replace(before, after)
  assert.equal(lowered.replace(after, before), value)
  return lowered
}

async function fixture(options = {}) {
  const requests = [], reads = [], clients = [], writes = [], saved = new Map(options.saved ?? [])
  let blocked = false, tick = 0, clock = null, onFetch = null, onStateWrite = null, onClient = null
  const request = (rows, values) => {
    let resolve, reject
    const promise = new Promise((yes, no) => {resolve = yes; reject = no})
    rows.push({...values, resolve, reject, answered: false}); return promise
  }
  const context = createContext({URL, URLSearchParams,
    location: {search: options.search ?? '', protocol: 'http:'},
    performance: {now: () => clock ?? ++tick}, AbortSignal: {timeout: milliseconds => ({milliseconds})},
    localStorage: {getItem: key => saved.get(key) ?? null,
      setItem(key, value) {saved.set(key, value); writes.push({key, value})},
      removeItem(key) {saved.delete(key); writes.push({key, value: null})}},
    fetch(url, values) {if (onFetch) onFetch(); return request(requests, {url, options: values})},
  })
  const dependencies = {
    vue: {reactive: value => new Proxy(value, {set(target, key, next) {
      const changed = !Object.is(target[key], next); target[key] = next
      if (changed && onStateWrite) onStateWrite(key, next); return true
    }}), computed: get => ({get value() {return get()}})},
    '@zvm/web/url': {isLoopback: () => false, mixedContentBlocked: () => blocked},
    './abi': {MOZAIC_ABI: 'canvas-ABI-port', ROUTER_ABI: 'router-ABI-port'},
    viem: {isAddress: value => /^0x[0-9a-fA-F]{40}$/.test(value), http: (rpc, values) => ({rpc, options: values}),
      createPublicClient(values) {
        clients.push(values); if (onClient) onClient()
        return {readContract: params => request(reads, {params, client: values})}
      }},
  }
  const module = new SourceTextModule(stripTypeScriptTypes(lowerErrorConstructor(source), {mode: 'strip'}), {
    context, initializeImportMeta(meta) {
      meta.env = {VITE_ZVM_NODE: alpha, ...(options.env ?? {})}
      meta.glob = () => Object.fromEntries((options.deployments ?? []).map((row, i) => ['deployment-' + i, row]))
    },
  })
  await module.link(name => {
    const values = dependencies[name]; assert.ok(values, 'Only declared endpoint capabilities may be linked: ' + name)
    return new SyntheticModule(Object.keys(values), function() {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, {context})
  })
  await module.evaluate({timeout: 5000})
  const api = module.namespace
  const reply = async (row, body, status = 200) => {
    assert.ok(row && !row.answered, 'Resolve only one original pending memory fetch')
    row.answered = true
    row.resolve({ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Unavailable', json: async () => body})
    await settle()
  }
  const approve = async (host, chainId = 1) => {
    await reply(requests.find(row => !row.answered && row.url === urlOf(host)), {result: '0x' + chainId.toString(16)})
    const info = requests.find(row => !row.answered && row.url === host + '/api/info')
    if (info) await reply(info, {})
  }
  const reject = async row => {
    assert.ok(row && !row.answered); row.answered = true
    row.reject(new Error('Memory-only unavailable endpoint')); await settle()
  }
  const answer = async (index, value) => {
    const row = reads[index]; assert.ok(row && !row.answered, 'Resolve only one original pending memory contract read')
    row.answered = true; row.resolve(value); await settle()
  }
  const canvas = async (start = 0, width = 1000, height = 1000, price = 9n) => {
    assert.deepEqual(reads.slice(start, start + 4).map(row => row.params.functionName), ['WIDTH', 'HEIGHT', 'price', 'owner'])
    for (const [i, value] of [width, height, price, OWNER].entries()) await answer(start + i, value)
  }
  return {api, requests, reads, clients, writes, saved, reply, approve, reject, answer, canvas,
    time: value => {clock = value}, block: value => {blocked = value}, reenterFetch: callback => {onFetch = callback},
    observeState: callback => {onStateWrite = callback}, reenterClient: callback => {onClient = callback},
    seed(values = {}) {Object.assign(api.endpoint, {rpc: urlOf(alpha), chainId: 1, health: 'ok', contract: CANVAS_A, ...values})},
    async healthy(host = alpha, chainId = 1) {
      const pending = api.setEndpoint(urlOf(host)); await approve(host, chainId)
      const start = reads.findIndex(row => !row.answered && row.params.functionName === 'WIDTH')
      if (start !== -1) await canvas(start)
      const router = reads.findIndex(row => !row.answered && row.params.functionName === 'canvas')
      if (router !== -1) await answer(router, api.endpoint.contract)
      assert.equal(await pending, true)
    },
  }
}

test('a current successful selection preserves the original read and normalized endpoint', async () => {
  const f = await fixture(); await f.healthy(beta, 27)
  assert.equal(selected(f.api), urlOf(beta)); assert.equal(f.api.endpoint.chainId, 27)
  assert.equal(f.api.endpoint.health, 'ok'); assert.equal(f.api.reachable.value, true)
  assert.equal(f.api.endpoint.error, null); assert.equal(f.api.endpoint.hint, null)
  assert.equal(f.writes.at(-1).value, urlOf(beta))
  assert.ok(f.api.endpoint.latency >= 0)
  assert.equal(f.requests[0].options.signal.milliseconds, 8000)
  if (rpc) {
    assert.deepEqual(JSON.parse(f.requests[0].options.body), {jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: []})
    assert.equal(f.api.endpoint.apiBase, beta)
  }
})
test('concurrent checks of the same selection share one pending request', async () => {
  const f = await fixture(), first = f.api.check(), again = f.api.check()
  assert.equal(first, again); assert.equal(f.requests.length, 1)
  await f.approve(alpha); assert.equal(await first, true)
  const later = f.api.check(); assert.notEqual(later, first)
  await f.approve(alpha, 2); assert.equal(await later, true)
})
test('a new selection starts independently and refuses the older successful reply', async () => {
  const f = await fixture(), old = f.api.setEndpoint(urlOf(alpha)), next = f.api.setEndpoint(urlOf(beta))
  assert.equal(f.requests.length, 2)
  await f.approve(beta, 2); assert.equal(await next, true)
  await f.approve(alpha, 1); assert.equal(await old, false)
  assert.equal(selected(f.api), urlOf(beta)); assert.equal(f.api.endpoint.chainId, 2)
  assert.equal(f.api.endpoint.health, 'ok'); assert.equal(f.writes.at(-1).value, urlOf(beta))
})
test('an old failure cannot overwrite a newer healthy selection', async () => {
  const f = await fixture(), old = f.api.setEndpoint(urlOf(alpha)), next = f.api.setEndpoint(urlOf(beta))
  await f.approve(beta, 2); await next; await f.reject(f.requests[0]); assert.equal(await old, false)
  assert.equal(f.api.endpoint.health, 'ok'); assert.equal(f.api.endpoint.chainId, 2); assert.equal(f.api.endpoint.error, null)
})
test('an older finally cannot clear the current in-flight check', async () => {
  const f = await fixture(), old = f.api.setEndpoint(urlOf(alpha)), next = f.api.setEndpoint(urlOf(beta))
  await f.approve(alpha); await old
  const again = f.api.check(); assert.equal(f.requests.length, 2)
  await f.approve(beta, 2); assert.equal(await next, true); assert.equal(await again, true)
})
test('an A-to-B-to-A selection refuses both obsolete generations', async () => {
  const f = await fixture(), first = f.api.setEndpoint(urlOf(alpha)), middle = f.api.setEndpoint(urlOf(beta)), last = f.api.setEndpoint(urlOf(alpha))
  assert.equal(f.requests.length, 3)
  await f.reply(f.requests[2], rpc ? {result: '0x3'} : {l2: {chainId: 3}})
  if (rpc) await f.reply(f.requests[3], {l2: {chainId: 3}})
  assert.equal(await last, true)
  await f.reply(f.requests[1], rpc ? {result: '0x2'} : {l2: {chainId: 2}})
  await f.reply(f.requests[0], rpc ? {result: '0x1'} : {l2: {chainId: 1}})
  assert.equal(await first, false); assert.equal(await middle, false)
  assert.equal(f.api.endpoint.chainId, 3); assert.equal(selected(f.api), urlOf(alpha))
  assert.equal(f.requests.length, rpc ? 4 : 3)
})
test('invalid input immediately clears the old deployment and invalidates pending success', async () => {
  const f = await fixture(); await f.healthy(alpha, 1)
  const old = f.api.check(); assert.equal(await f.api.setEndpoint(''), false)
  assert.equal(f.api.endpoint.chainId, null); assert.equal(f.api.endpoint.latency, null)
  assert.equal(f.api.endpoint.health, 'error'); const error = f.api.endpoint.error
  if (rpc) {assert.equal(f.api.endpoint.apiBase, null)}
  await f.approve(alpha, 2); assert.equal(await old, false)
  assert.equal(f.api.endpoint.health, 'error'); assert.equal(f.api.endpoint.error, error); assert.equal(f.api.endpoint.chainId, null)
})
test('invalid input also refuses a pending failure', async () => {
  const f = await fixture(), old = f.api.check(); await f.api.setEndpoint('')
  const error = f.api.endpoint.error; await f.reject(f.requests[0]); assert.equal(await old, false)
  assert.equal(f.api.endpoint.error, error)
})
test('starting a recheck clears previously established chain and deployment state', async () => {
  const f = await fixture(); await f.healthy(alpha, 1)
  const pending = f.api.check()
  assert.equal(f.api.endpoint.health, 'checking'); assert.equal(f.api.endpoint.chainId, null); assert.equal(f.api.endpoint.latency, null)
  if (rpc) {assert.equal(f.api.endpoint.apiBase, null)}
  await f.approve(alpha, 2); assert.equal(await pending, true); assert.equal(f.api.endpoint.chainId, 2)
})
test('a repeated explicit selection is a new generation even for the same URL', async () => {
  const f = await fixture(), old = f.api.setEndpoint(urlOf(alpha)), next = f.api.setEndpoint(urlOf(alpha))
  assert.equal(f.requests.length, 2)
  await f.reply(f.requests[1], rpc ? {result: '0x2'} : {l2: {chainId: 2}})
  if (rpc) await f.reply(f.requests[2], {l2: {chainId: 2}})
  await next; await f.reply(f.requests[0], rpc ? {result: '0x1'} : {l2: {chainId: 1}})
  assert.equal(await old, false); assert.equal(f.api.endpoint.chainId, 2)
})
test('a current request failure remains unavailable rather than preserving old chain metadata', async () => {
  const f = await fixture(); await f.healthy(alpha)
  const pending = f.api.setEndpoint(urlOf(beta)); await f.reject(f.requests.at(-1)); assert.equal(await pending, false)
  assert.equal(f.api.endpoint.health, 'error'); assert.equal(f.api.endpoint.chainId, null); assert.equal(f.api.endpoint.latency, null)
  assert.ok(f.api.endpoint.error); if (rpc) assert.equal(f.api.endpoint.apiBase, null)
})
test('mixed-content refusal performs no new fetch and clears the old chain metadata', async () => {
  const f = await fixture(); await f.healthy(alpha); const count = f.requests.length
  f.block(true); assert.equal(await f.api.setEndpoint(urlOf(beta)), false)
  assert.equal(f.requests.length, count); assert.equal(f.api.endpoint.health, 'error'); assert.equal(f.api.endpoint.chainId, null)
})
test('an HTTP failure is classified only for the current selection', async () => {
  const f = await fixture(), pending = f.api.setEndpoint(urlOf(beta))
  await f.reply(f.requests[0], {}, 503); assert.equal(await pending, false)
  assert.equal(f.api.endpoint.chainId, null); assert.match(f.api.endpoint.error, /503/)
})
test('a non-node response cannot establish endpoint health', async () => {
  const f = await fixture(), pending = f.api.setEndpoint(urlOf(beta))
  await f.reply(f.requests[0], {}); assert.equal(await pending, false)
  assert.equal(f.api.endpoint.health, 'error'); assert.equal(f.api.endpoint.chainId, null)
})
if (rpc) {
  test('an old API-info response cannot replace a newly selected deployment', async () => {
    const f = await fixture(), old = f.api.setEndpoint(urlOf(alpha))
    await f.reply(f.requests[0], {result: '0x1'}); const oldInfo = f.requests[1]
    const next = f.api.setEndpoint(urlOf(beta)); await f.approve(beta, 2); await next
    await f.reply(oldInfo, {l2: {chainId: 1}, apps: {exchange: 'obsolete'}})
    assert.equal(await old, false); assert.equal(f.api.endpoint.apiBase, beta)
  })
  test('an obsolete failed bare-host candidate cannot start a fallback request', async () => {
    const f = await fixture(), old = f.api.setEndpoint(alpha), next = f.api.setEndpoint(urlOf(beta))
    await f.approve(beta, 2); await next; const count = f.requests.length
    await f.reject(f.requests[0]); assert.equal(await old, false); assert.equal(f.requests.length, count)
    assert.equal(f.api.endpoint.chainId, 2)
  })
  test('the current bare-host selection preserves both original candidates and canonical RPC persistence', async () => {
    const f = await fixture(), pending = f.api.setEndpoint(beta)
    assert.equal(f.requests[0].url, beta + '/rpc'); await f.reject(f.requests[0]); assert.equal(f.requests[1].url, beta)
    await f.reply(f.requests[1], {result: '0x2'}); assert.equal(await pending, true)
    assert.equal(f.api.endpoint.rpc, beta); assert.equal(f.writes.at(-1).value, beta); assert.equal(f.api.endpoint.apiBase, null)
  })
  test('a reachable RPC with an unavailable optional API preserves its read-only RPC capability', async () => {
    const f = await fixture(), pending = f.api.setEndpoint(urlOf(beta))
    await f.reply(f.requests[0], {result: '0x2'}); await f.reject(f.requests[1]); assert.equal(await pending, true)
    assert.equal(f.api.endpoint.chainId, 2); assert.equal(f.api.endpoint.apiBase, null)
  })
}

test('a synchronous fetch callback shares the already-owned current promise', async () => {
  const f = await fixture(); let nested
  f.reenterFetch(() => {nested = f.api.check()})
  const pending = f.api.check(); assert.equal(nested, pending); assert.equal(f.requests.length, 1)
  await f.approve(alpha, 27); assert.equal(await pending, true)
})
test('canonical bare-host resolution still shares the owned promise during a reactive URL callback', async () => {
  const f = await fixture(); let nested
  f.observeState(key => {if (key === 'rpc') nested = f.api.check()})
  const pending = f.api.setEndpoint(beta); await f.approve(beta, 2)
  assert.equal(await pending, true); assert.equal(await nested, true)
  assert.equal(f.requests.length, 2); assert.equal(f.api.endpoint.rpc, urlOf(beta))
})
test('a reactive new selection during health publication refuses the older completion', async () => {
  const f = await fixture(); let next
  f.observeState((key, value) => {if (key === 'health' && value === 'ok' && !next) next = f.api.setEndpoint(urlOf(beta))})
  const old = f.api.setEndpoint(urlOf(alpha)); await f.approve(alpha, 1)
  assert.equal(await old, false); assert.equal(f.api.endpoint.rpc, urlOf(beta)); assert.equal(f.api.endpoint.chainId, null)
  assert.equal(f.api.endpoint.health, 'checking'); await f.approve(beta, 2); assert.equal(await next, true)
  assert.equal(f.api.endpoint.chainId, 2)
})

test('an unavailable optional API keeps RPC readiness separate from a missing canvas', async () => {
  const f = await fixture(), pending = f.api.check(); await f.reply(f.requests[0], {result: '0x1'}); await f.reject(f.requests[1])
  assert.equal(await pending, true); assert.equal(f.api.reachable.value, true); assert.equal(f.api.ready.value, false)
  assert.equal(f.api.explorerUrl('/tx/example'), null); assert.match(f.api.endpoint.contractError, /No Mozaic/)
})
test('deployment, build, saved and link precedence preserve per-chain deployment blocks', async () => {
  for (const [options, address, origin, block] of [
    [{deployments: [{chainId: 1, mozaic: CANVAS_A, deployBlock: 40}]}, CANVAS_A, 'deployment', 40],
    [{env: {VITE_MOZAIC_CONTRACT: CANVAS_B}, deployments: [{chainId: 1, mozaic: CANVAS_A, deployBlock: 40}]}, CANVAS_B, 'build', null],
    [{saved: [['mozaic.contract.1', CANVAS_A]], env: {VITE_MOZAIC_CONTRACT: CANVAS_B}, deployments: [{chainId: 1, mozaic: CANVAS_A, deployBlock: 40}]}, CANVAS_A, 'saved', 40],
    [{search: '?contract=' + CANVAS_B, saved: [['mozaic.contract.1', CANVAS_A]], env: {VITE_MOZAIC_CONTRACT: CANVAS_A}}, CANVAS_B, 'link', null],
  ]) {
    const f = await fixture(options); await f.healthy()
    assert.equal(f.api.endpoint.contract, address); assert.equal(f.api.endpoint.contractSource, origin)
    assert.equal(f.api.endpoint.deployBlock, block); assert.equal(f.api.ready.value, true)
    assert.equal(f.reads.length, 4); assert.ok(f.reads.every(row => row.params.address === address && row.params.abi === 'canvas-ABI-port'))
    assert.ok(f.clients.every(row => row.transport.rpc === urlOf(alpha) && row.transport.options.batch === true))
  }
})
test('an explicit canvas choice replaces the visit link and is saved only for its chain', async () => {
  const f = await fixture({search: '?contract=' + CANVAS_A}); await f.healthy()
  assert.equal(f.saved.has('mozaic.contract.1'), false)
  const pending = f.api.setContract(CANVAS_B); await f.canvas(4, 640, 480, 13n); assert.equal(await pending, true)
  assert.equal(f.saved.get('mozaic.contract.1'), CANVAS_B); assert.equal(f.api.endpoint.contractSource, 'saved')
  assert.deepEqual({...f.api.endpoint.canvas}, {width: 640, height: 480, price: 13n, owner: OWNER})
  const unknown = f.api.setEndpoint(urlOf(beta)); await f.approve(beta, 2); await unknown
  assert.equal(f.api.endpoint.contract, null); assert.equal(f.saved.has('mozaic.contract.2'), false)
})
test('clearing a saved canvas restores the original build and recorded router lookup', async () => {
  const f = await fixture({saved: [['mozaic.contract.1', CANVAS_B]], deployments: [{chainId: 1, mozaic: CANVAS_A, router: ROUTER_A, deployBlock: 10}]})
  await f.healthy(); const pending = f.api.setContract(''); await f.canvas(4)
  assert.equal(f.reads[8].params.address, ROUTER_A); assert.equal(f.reads[8].params.abi, 'router-ABI-port')
  await f.answer(8, CANVAS_A); assert.equal(await pending, true); assert.equal(f.api.endpoint.router, ROUTER_A)
  assert.equal(f.saved.has('mozaic.contract.1'), false); assert.equal(f.api.endpoint.contractSource, 'deployment')
})
test('a current canvas check coalesces through all four reads and the optional router', async () => {
  const f = await fixture({search: '?router=' + ROUTER_A}); f.seed(); const pending = f.api.checkContract()
  for (let i = 0; i < 200; i++) assert.equal(f.api.checkContract(), pending)
  assert.equal(f.reads.length, 4); await f.canvas(); assert.equal(f.reads.length, 5)
  assert.equal(f.api.checkContract(), pending); await f.answer(4, CANVAS_A); assert.equal(await pending, true)
  assert.equal(f.api.endpoint.router, ROUTER_A)
})
test('synchronous client construction shares the already-owned complete canvas promise', async () => {
  const f = await fixture(); f.seed(); let nested
  f.reenterClient(() => {nested = f.api.checkContract()}); const pending = f.api.checkContract()
  assert.equal(nested, pending); assert.equal(f.clients.length, 1); assert.equal(f.reads.length, 4)
  await f.canvas(); assert.equal(await pending, true)
})
test('a delayed old canvas cannot replace a newer selected canvas', async () => {
  const f = await fixture(); f.seed(); const old = f.api.checkContract(), next = f.api.setContract(CANVAS_B)
  await f.canvas(4, 640, 480, 13n); assert.equal(await next, true); await f.canvas(0, 10, 10, 1n)
  assert.equal(await old, false); assert.equal(f.api.endpoint.contract, CANVAS_B); assert.equal(f.api.endpoint.canvas.width, 640)
})
test('an invalid canvas input invalidates pending success while keeping the prior address choice', async () => {
  const f = await fixture(); f.seed(); const old = f.api.checkContract()
  assert.equal(await f.api.setContract('invalid'), false); assert.equal(f.api.endpoint.contract, CANVAS_A)
  assert.equal(f.api.endpoint.canvas, null); assert.equal(f.api.endpoint.router, null); const error = f.api.endpoint.contractError
  await f.canvas(); assert.equal(await old, false); assert.equal(f.api.endpoint.canvas, null); assert.equal(f.api.endpoint.contractError, error)
})
test('a pending canvas failure cannot overwrite a newer success or release its read slot', async () => {
  const f = await fixture(); f.seed(); const old = f.api.checkContract(), next = f.api.setContract(CANVAS_B)
  await f.reject(f.reads[0]); assert.equal(await old, false); const shared = f.api.checkContract()
  assert.equal(f.reads.length, 8); await f.canvas(4); assert.equal(await next, true); assert.equal(await shared, true)
  assert.equal(f.api.endpoint.contractError, null); for (const index of [1, 2, 3]) await f.answer(index, 0n)
})
test('a delayed router cannot attach an old router to a newer canvas', async () => {
  const f = await fixture({search: '?router=' + ROUTER_A}); f.seed(); const old = f.api.checkContract(); await f.canvas(0)
  const next = f.api.setContract(CANVAS_B); await f.canvas(5, 640); await f.answer(9, CANVAS_A); assert.equal(await next, true)
  await f.answer(4, CANVAS_A); assert.equal(await old, false); assert.equal(f.api.endpoint.canvas.width, 640)
  assert.equal(f.api.endpoint.contract, CANVAS_B); assert.equal(f.api.endpoint.router, null)
})
test('recorded routers must still front the captured canvas on its captured chain', async () => {
  const f = await fixture({deployments: [{chainId: 1, mozaic: CANVAS_A, router: ROUTER_A}, {chainId: 2, mozaic: CANVAS_A, router: ROUTER_B}]})
  f.seed(); const old = f.api.checkContract(); const next = f.api.setEndpoint(urlOf(beta))
  await f.approve(beta, 2); await f.canvas(4); assert.equal(f.reads[8].params.address, ROUTER_B)
  await f.answer(8, CANVAS_A); await next; await f.canvas(0); assert.equal(await old, false)
  assert.equal(f.api.endpoint.router, ROUTER_B); assert.equal(f.api.endpoint.chainId, 2); assert.equal(f.reads.length, 9)
})
test('a missing, invalid, mismatched or failing router preserves direct-canvas readiness', async () => {
  for (const mode of ['missing', 'invalid', 'mismatch', 'failure']) {
    const f = await fixture({search: mode === 'missing' ? '' : '?router=' + (mode === 'invalid' ? 'invalid' : ROUTER_A)})
    f.seed(); const pending = f.api.checkContract(); await f.canvas()
    if (mode === 'mismatch') await f.answer(4, CANVAS_B)
    if (mode === 'failure') await f.reject(f.reads[4])
    assert.equal(await pending, true); assert.equal(f.api.endpoint.router, null); assert.equal(f.api.ready.value, true)
    assert.equal(f.reads.length, ['missing', 'invalid'].includes(mode) ? 4 : 5)
  }
})
test('node recheck and invalid input clear every old canvas and router field', async () => {
  const f = await fixture({deployments: [{chainId: 1, mozaic: CANVAS_A, router: ROUTER_A, deployBlock: 10}]}); await f.healthy()
  const old = f.api.check(); for (const key of ['chainId', 'latency', 'apiBase', 'contract', 'contractSource', 'deployBlock', 'canvas', 'router', 'contractError']) assert.equal(f.api.endpoint[key], null)
  assert.equal(await f.api.setEndpoint(''), false); await f.approve(alpha, 2); assert.equal(await old, false)
  assert.equal(f.api.endpoint.router, null); assert.equal(f.api.ready.value, false)
})
test('reactive new canvas selection during canvas publication refuses the older router lookup', async () => {
  const f = await fixture({search: '?router=' + ROUTER_A}); f.seed(); let next
  f.observeState((key, value) => {if (key === 'canvas' && value?.width === 1000) next = f.api.setContract(CANVAS_B)})
  const old = f.api.checkContract(); await f.canvas(0); assert.equal(await old, false); assert.equal(f.reads.length, 8)
  await f.canvas(4, 640); await f.answer(8, CANVAS_B); assert.equal(await next, true); assert.equal(f.api.endpoint.canvas.width, 640)
})
test('a synchronous user canvas choice during chain publication wins over defaults', async () => {
  const f = await fixture({deployments: [{chainId: 1, mozaic: CANVAS_A}]}); let chosen
  f.observeState((key, value) => {if (key === 'chainId' && value === 1) chosen = f.api.setContract(CANVAS_B)})
  const pending = f.api.check(); await f.approve(alpha); assert.equal(f.reads.length, 4); await f.canvas()
  assert.equal(await chosen, true); assert.equal(await pending, true); assert.equal(f.api.endpoint.contract, CANVAS_B)
  assert.equal(f.api.endpoint.contractSource, 'saved'); assert.equal(f.reads[0].params.address, CANVAS_B)
})
test('reactive node replacement during recheck initialization cannot clear its newer metadata', async () => {
  const f = await fixture(); await f.healthy(); let next
  f.observeState((key, value) => {if (key === 'health' && value === 'checking') {f.observeState(null); next = f.api.setEndpoint(urlOf(beta))}})
  const old = f.api.check(); assert.equal(await old, false); assert.equal(f.requests.length, 3)
  await f.approve(beta, 2); assert.equal(await next, true); assert.equal(f.api.endpoint.chainId, 2)
})
test('current canvas errors keep the captured address and chain and recover on the next read', async () => {
  const f = await fixture(); f.seed(); const pending = f.api.checkContract(); await f.reject(f.reads[0]); assert.equal(await pending, false)
  assert.match(f.api.endpoint.contractError, new RegExp(CANVAS_A + ' on chain 1'))
  for (const index of [1, 2, 3]) await f.answer(index, 0n)
  const next = f.api.checkContract(); await f.canvas(4); assert.equal(await next, true); assert.equal(f.api.endpoint.contractError, null)
})

test('RPC latency excludes time spent waiting for the optional API lookup', async () => {
  const f = await fixture(); f.time(1000); const pending = f.api.check()
  f.time(1100); await f.reply(f.requests[0], {result: '0x1'})
  assert.equal(f.requests[1].url, alpha + '/api/info')
  f.time(1900); await f.reply(f.requests[1], {})
  assert.equal(await pending, true); assert.equal(f.api.endpoint.latency, 100)
  assert.equal(f.api.endpoint.apiBase, alpha); assert.equal(f.requests.length, 2)
})
