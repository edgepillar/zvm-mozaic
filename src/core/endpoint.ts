// Which node, and which canvas on it.
//
// There is no backend: this is a static bundle, so both are settings. The node
// is an RPC URL, because that is what people have to hand. The canvas is a
// contract address, found in this order:
//
//   1. ?contract=0x… in the link, so a canvas can be shared with its address;
//   2. what the person typed into the node dialog, kept per chain id;
//   3. VITE_MOZAIC_CONTRACT, for a build pinned to one canvas;
//   4. deployments/*.json, the record `npm run deploy` writes, by chain id.
//
// Mozaic needs nothing but JSON-RPC. When the RPC is a zvm node's (it ends in
// /rpc and /api/info answers beside it), the node's explorer links and faucet
// are offered as well; a bare op-reth works without them.

import {computed, reactive} from 'vue'
import {createPublicClient, http, isAddress, type Address} from 'viem'
import {isLoopback, mixedContentBlocked} from '@zvm/web/url'
import {MOZAIC_ABI, ROUTER_ABI} from './abi'

export {isLoopback, mixedContentBlocked}

const KEY = 'mozaic.rpc'
const CONTRACT_KEY = (chainId: number) => `mozaic.contract.${chainId}`

export interface Preset {
  label: string
  url: string
  note: string
}

export interface Deployment {
  chainId: number
  mozaic: Address
  deployBlock?: number
  owner?: Address
  /** MozaicRouter: compact paints, and sessions painting in their funder's name. */
  router?: Address
}

/** Every deployment record in the repo, bundled at build time. */
const DEPLOYMENTS: Deployment[] = Object.values(
  import.meta.glob<Deployment>('../../deployments/*.json', {eager: true, import: 'default'}),
)

// The node this build reads, and any others its picker offers, come from the
// environment (see .env.example), so no node is written into the source.
// VITE_ZVM_NODE is a ZVM node's base URL, its JSON-RPC at /rpc; a local
// zvm-devnet's is http://localhost:47080/zvm. VITE_ZVM_PRESETS
// adds more to the picker, as comma-separated `label=url` pairs.
const NODE = (import.meta.env.VITE_ZVM_NODE as string).replace(/\/+$/, '')
const BUILT_IN_CONTRACT = (import.meta.env.VITE_MOZAIC_CONTRACT as string | undefined) || ''

export const DEFAULT_RPC = `${NODE}/rpc`

/** Somewhere to start. Any of them can be replaced with a pasted URL. */
export const PRESETS: Preset[] = [
  {label: 'This build\'s node', url: DEFAULT_RPC, note: new URL(DEFAULT_RPC).host},
  ...((import.meta.env.VITE_ZVM_PRESETS as string | undefined) ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=')
      const url = i < 0 ? p : p.slice(i + 1).trim()
      return {label: i < 0 ? url : p.slice(0, i).trim(), url, note: url}
    }),
]

export type Health = 'idle' | 'checking' | 'ok' | 'error'

export interface CanvasInfo {
  width: number
  height: number
  price: bigint
  owner: Address
}

export interface EndpointState {
  rpc: string
  health: Health
  error: string | null
  hint: string | null
  latency: number | null
  chainId: number | null
  /** The zvm node's base, for explorer links and the faucet; null for a bare RPC. */
  apiBase: string | null
  contract: Address | null
  /** Where the contract address came from, said in the node dialog. */
  contractSource: 'link' | 'saved' | 'build' | 'deployment' | null
  /** The block it was deployed at, when known: history is never read before it. */
  deployBlock: number | null
  canvas: CanvasInfo | null
  contractError: string | null
  /** The router in front of this canvas, when one is known and answers for it. */
  router: Address | null
}

export const endpoint = reactive<EndpointState>({
  rpc: initial(),
  health: 'idle',
  error: null,
  hint: null,
  latency: null,
  chainId: null,
  apiBase: null,
  contract: null,
  contractSource: null,
  deployBlock: null,
  canvas: null,
  contractError: null,
  router: null,
})

// A contract in the link wins once, for this visit; it is not saved over the
// person's own choice unless they keep it from the dialog.
let linkContract: Address | null = null
try {
  const c = new URLSearchParams(location.search).get('contract')
  if (c && isAddress(c)) linkContract = c
} catch {
  /* no location */
}

export function normalize(input: string): string {
  let s = input.trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return ''
  }
}

function initial(): string {
  try {
    const q = new URLSearchParams(location.search)
    const fromQuery = q.get('rpc') ?? q.get('node')
    if (fromQuery) {
      const url = normalize(fromQuery)
      if (url) {
        save(KEY, url)
        return url
      }
    }
  } catch {
    /* no query */
  }
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return saved
  } catch {
    /* storage can be blocked */
  }
  return DEFAULT_RPC
}

function save(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage can be blocked; the setting still holds for this tab */
  }
}

export const rpcUrl = () => endpoint.rpc

export function deploymentFor(chainId: number): Deployment | null {
  return DEPLOYMENTS.find((d) => d.chainId === chainId) ?? null
}

function resolveContract(chainId: number): Pick<EndpointState, 'contract' | 'contractSource' | 'deployBlock'> {
  const known = deploymentFor(chainId)
  const block = (a: Address) => (known && known.mozaic.toLowerCase() === a.toLowerCase() ? (known.deployBlock ?? null) : null)
  if (linkContract) return {contract: linkContract, contractSource: 'link', deployBlock: block(linkContract)}
  let saved: string | null = null
  try {
    saved = localStorage.getItem(CONTRACT_KEY(chainId))
  } catch {
    /* blocked storage */
  }
  if (saved && isAddress(saved)) return {contract: saved, contractSource: 'saved', deployBlock: block(saved)}
  if (BUILT_IN_CONTRACT && isAddress(BUILT_IN_CONTRACT)) return {contract: BUILT_IN_CONTRACT, contractSource: 'build', deployBlock: block(BUILT_IN_CONTRACT)}
  if (known) return {contract: known.mozaic, contractSource: 'deployment', deployBlock: known.deployBlock ?? null}
  return {contract: null, contractSource: null, deployBlock: null}
}

/** Points the app at a different node and re-checks it. */
export async function setEndpoint(input: string): Promise<boolean> {
  const url = normalize(input), generation = ++selectionGeneration
  checking = null
  const current = () => selectionGeneration === generation
  if (!url) {
    fail('That is not a URL.', `Try ${DEFAULT_RPC}`, current)
    return false
  }
  endpoint.rpc = url
  if (!current() || endpoint.rpc !== url) return false
  save(KEY, url)
  if (!current() || endpoint.rpc !== url) return false
  return check()
}

/**
 * Points the app at a different canvas on this chain, or back at the
 * recorded one when given an empty string.
 */
export async function setContract(input: string): Promise<boolean> {
  const chainId = endpoint.chainId
  if (chainId === null) return false
  const rpc = endpoint.rpc, generation = selectionGeneration, selected = ++contractGeneration
  canvasReading = null
  const current = () => selectionGeneration === generation && contractGeneration === selected &&
    endpoint.rpc === rpc && endpoint.chainId === chainId
  if (!clearCanvas(current)) return false
  const s = input.trim()
  if (s && !isAddress(s)) {
    endpoint.contractError = 'That is not a contract address: 0x and 40 hex characters.'
    return false
  }
  linkContract = null
  save(CONTRACT_KEY(chainId), s || null)
  if (!current()) return false
  for (const [key, value] of Object.entries(resolveContract(chainId))) {
    if (!current()) return false
    Object.assign(endpoint, {[key]: value})
  }
  return current() ? checkContract() : false
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`${status} ${statusText}`)
  }
}

async function chainIdOf(url: string, timeoutMs: number): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: []}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new HttpError(res.status, res.statusText)
  const body = await res.json()
  const id = Number(body?.result)
  if (!Number.isFinite(id) || id <= 0) throw new Error('not an EVM RPC')
  return id
}

async function isZvmNode(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/api/info`, {signal: AbortSignal.timeout(6000)})
    return res.ok
  } catch {
    return false
  }
}

let selectionGeneration = 0
let contractGeneration = 0
let checking: {url: string; generation: number; promise: Promise<boolean>} | null = null
let canvasReading: {current: () => boolean; promise: Promise<boolean>} | null = null

export function check(): Promise<boolean> {
  const url = endpoint.rpc, generation = selectionGeneration
  if (checking?.url === url && checking.generation === generation) return checking.promise
  let selectedURL = url
  const current = () => selectionGeneration === generation && endpoint.rpc === selectedURL
  let accept!: (value: boolean) => void
  let decline!: (reason: unknown) => void
  const completed = new Promise<boolean>((resolve, reject) => {accept = resolve; decline = reject})
  const promise = completed.finally(() => {
    if (checking?.promise === promise) checking = null
  })
  // Register ownership before fetch or a reactive observer can reenter.
  checking = {url, generation, promise}
  const selectRPC = (candidate: string) => {
    if (!current()) return false
    selectedURL = candidate
    if (checking?.promise === promise) checking.url = candidate
    endpoint.rpc = candidate
    return current()
  }
  void run(url, current, selectRPC).then(accept, decline)
  return promise
}

async function run(url: string, current: () => boolean, selectRPC: (candidate: string) => boolean): Promise<boolean> {
  endpoint.health = 'checking'
  if (!current() || !clearChain(current)) return false
  endpoint.error = null
  if (!current()) return false
  endpoint.hint = null
  if (!current()) return false

  if (mixedContentBlocked(url)) {
    fail(
      `This page is served over HTTPS and cannot reach ${hostOf(url)} over plain HTTP.`,
      'Use an HTTPS address, or http://localhost, which browsers allow from an HTTPS page.',
      current,
    )
    return false
  }

  const bare = new URL(url).pathname.replace(/\/+$/, '') === ''
  const candidates = bare ? [`${url}/rpc`, url] : [url]
  const started = performance.now()
  let last: unknown = null
  for (const candidate of candidates) {
    try {
      const chainId = await chainIdOf(candidate, 8000)
      if (!current()) return false
      const latency = Math.round(performance.now() - started)
      const base = /\/rpc$/.test(candidate) ? candidate.replace(/\/rpc$/, '') : null
      const apiBase = base && (await isZvmNode(base)) ? base : null
      if (!current() || !selectRPC(candidate)) return false
      save(KEY, candidate)
      if (!current()) return false
      const selectedContract = contractGeneration
      endpoint.chainId = chainId
      if (!current()) return false
      endpoint.latency = latency
      if (!current()) return false
      endpoint.apiBase = apiBase
      if (!current()) return false
      // A synchronous user choice during publication takes precedence.
      for (const [key, value] of Object.entries(resolveContract(chainId))) {
        if (!current()) return false
        if (contractGeneration !== selectedContract) break
        Object.assign(endpoint, {[key]: value})
      }
      if (!current()) return false
      endpoint.health = 'ok'
      if (!current()) return false
      await checkContract()
      return current()
    } catch (err) {
      if (!current()) return false
      last = err
    }
  }
  if (!current()) return false
  describe(last, url, current)
  return false
}

/** Reads the canvas's shape and price, which also proves the address is a Mozaic. */
/**
 * The router for a canvas: ?router= in the link, else the recorded one when
 * the canvas is the recorded one. It is used only if it says it fronts this
 * canvas; otherwise the page paints the canvas directly, in its six-byte form.
 */
async function routerFor(client: ReturnType<typeof createPublicClient>, canvas: Address, chainId: number): Promise<Address | null> {
  let candidate: string | null = null
  try {
    candidate = new URLSearchParams(location.search).get('router')
  } catch {
    /* no location */
  }
  const known = deploymentFor(chainId)
  if (!candidate && known?.router && known.mozaic.toLowerCase() === canvas.toLowerCase()) candidate = known.router
  if (!candidate || !isAddress(candidate)) return null
  try {
    const fronts = await client.readContract({address: candidate, abi: ROUTER_ABI, functionName: 'canvas'})
    return fronts.toLowerCase() === canvas.toLowerCase() ? candidate : null
  } catch {
    return null
  }
}

export function checkContract(): Promise<boolean> {
  if (canvasReading?.current()) return canvasReading.promise
  const rpc = endpoint.rpc, chainId = endpoint.chainId, address = endpoint.contract
  const generation = selectionGeneration, selected = contractGeneration
  const current = () => selectionGeneration === generation && contractGeneration === selected &&
    endpoint.rpc === rpc && endpoint.chainId === chainId && endpoint.contract === address
  let accept!: (value: boolean) => void
  let decline!: (reason: unknown) => void
  const completed = new Promise<boolean>((resolve, reject) => {accept = resolve; decline = reject})
  const promise = completed.finally(() => {
    if (canvasReading?.promise === promise) canvasReading = null
  })
  canvasReading = {current, promise}
  void readCanvas(rpc, chainId, address, current).then(accept, decline)
  return promise
}

async function readCanvas(rpc: string, chainId: number | null, address: Address | null, current: () => boolean): Promise<boolean> {
  if (!clearCanvas(current)) return false
  if (!address || chainId === null) {
    endpoint.contractError = `No Mozaic is recorded for chain ${chainId}. Paste a contract address in the node menu.`
    return false
  }
  try {
    const client = createPublicClient({transport: http(rpc, {batch: true})})
    if (!current()) return false
    const read = (functionName: 'WIDTH' | 'HEIGHT' | 'price' | 'owner') => {
      if (!current()) throw new Error('Canvas context changed')
      return client.readContract({address, abi: MOZAIC_ABI, functionName})
    }
    const [width, height, price, owner] = await Promise.all([read('WIDTH'), read('HEIGHT'), read('price'), read('owner')])
    if (!current()) return false
    endpoint.canvas = {width: Number(width), height: Number(height), price: price as bigint, owner: owner as Address}
    if (!current()) return false
    const router = await routerFor(client, address, chainId)
    if (!current()) return false
    endpoint.router = router
    return current()
  } catch {
    if (current()) endpoint.contractError = `${address} on chain ${chainId} does not answer as a Mozaic canvas.`
    return false
  }
}

function describe(err: any, url: string, current: () => boolean) {
  if (err?.name === 'TimeoutError') {
    fail(`${hostOf(url)} did not answer within 8 seconds.`, 'The node may be starting up, or the port may be firewalled.', current)
    return
  }
  if (err instanceof HttpError) {
    fail(`${hostOf(url)} answered ${err.status} ${err.statusText}.`, 'Check the path. A ZVM node serves JSON-RPC at /rpc.', current)
    return
  }
  if (err?.message === 'not an EVM RPC') {
    fail(`${hostOf(url)} answered, but not like an EVM node.`, 'Point this at the ZVM RPC rather than the NoM RPC.', current)
    return
  }
  fail(
    `Could not reach ${hostOf(url)}.`,
    isLoopback(url)
      ? 'Start the node, or check the port. If it is running, your browser may be asking you to allow access to local network devices.'
      : 'Check the node is running and reachable, and that it allows requests from this page.',
    current,
  )
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function clearCanvas(current: () => boolean): boolean {
  for (const [key, value] of Object.entries({canvas: null, router: null, contractError: null})) {
    if (!current()) return false
    Object.assign(endpoint, {[key]: value})
  }
  return current()
}

function clearChain(current: () => boolean): boolean {
  if (!current()) return false
  contractGeneration++
  canvasReading = null
  for (const [key, value] of Object.entries({latency: null, chainId: null, apiBase: null,
    contract: null, contractSource: null, deployBlock: null, canvas: null, router: null, contractError: null})) {
    if (!current()) return false
    Object.assign(endpoint, {[key]: value})
  }
  return current()
}

function fail(error: string, hint: string | null, current: () => boolean) {
  if (!clearChain(current)) return
  endpoint.health = 'error'
  if (!current()) return
  endpoint.error = error
  if (!current()) return
  endpoint.hint = hint
}

export const reachable = computed(() => endpoint.health === 'ok')

/** Reachable, and a Mozaic answers at the configured address. */
export const ready = computed(() => reachable.value && !!endpoint.canvas)

/** The node's explorer page for a path, when the node has one. */
export const explorerUrl = (path: string) => (endpoint.apiBase ? `${endpoint.apiBase}${path}` : null)
