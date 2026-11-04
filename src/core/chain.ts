// The chain's heartbeat, and the one place this page polls the node.
//
// One NoM momentum orders exactly one ZVM block, about every fifteen seconds
// on the devnets, so the chain has a beat rather than a stream. The page looks
// once per `prefs.refresh` seconds (a momentum by default, never faster) with
// a single eth_blockNumber. Only when the head moved does it read that block,
// and only then do listeners run, each told the new head so none of them has
// to ask for it again. A hidden tab does not look at all, and one coming back
// looks at once.
//
// Everything that refreshes (the canvas, the totals, a wallet balance) hangs
// off onBlock, so a tab left open costs the node about four small requests a
// minute plus one log read per block that actually carried something.

import {reactive, watch} from 'vue'
import {endpoint, reachable} from './endpoint'
import {publicClient} from '@zvm/web/evm'
import {prefs} from './prefs'

export interface ChainState {
  chainId: number | null
  head: number | null
  /** Unix seconds of the head block. */
  timestamp: number | null
  baseFee: bigint | null
  /** Measured seconds between blocks, not the nominal ten. */
  interval: number
  /** Wall clock (ms) when the head last changed, for the pulse. */
  landedAt: number
  error: string | null
}

export const chain = reactive<ChainState>({
  chainId: null,
  head: null,
  timestamp: null,
  baseFee: null,
  interval: 15,
  landedAt: Date.now(),
  error: null,
})

const onBlockListeners = new Set<(head: number) => void>()

export function onBlock(fn: (head: number) => void): () => void {
  onBlockListeners.add(fn)
  return () => onBlockListeners.delete(fn)
}

let timer: number | undefined
let lastSeen: number | null = null
let started = false
let generation = 0
let armGeneration = 0
let reading: {generation: number; promise: Promise<void>} | null = null

const hidden = () => typeof document !== 'undefined' && document.hidden

function poll(): Promise<void> {
  if (!reachable.value || endpoint.chainId === null || hidden()) return Promise.resolve()
  const selected = generation
  if (reading?.generation === selected) return reading.promise
  const rpc = endpoint.rpc, chainId = endpoint.chainId
  const current = () => generation === selected && endpoint.rpc === rpc &&
    endpoint.chainId === chainId && reachable.value && !hidden()
  let accept!: () => void
  let decline!: (reason: unknown) => void
  const completed = new Promise<void>((resolve, reject) => {accept = resolve; decline = reject})
  const promise = completed.finally(() => {
    if (reading?.promise === promise) reading = null
  })
  reading = {generation: selected, promise}
  void read(chainId, current).then(accept, decline)
  return promise
}

async function read(chainId: number, current: () => boolean): Promise<void> {
  try {
    const client = publicClient(chainId)
    if (!current()) return
    const number = Number(await client.getBlockNumber({cacheTime: 0}))
    if (!current()) return
    chain.chainId = chainId
    if (!current()) return
    chain.error = null
    if (!current() || number === lastSeen) return
    const block = await client.getBlock({blockNumber: BigInt(number)})
    if (!current()) return
    chain.baseFee = block.baseFeePerGas ?? null
    if (!current()) return
    // Preserve the original per-block exponential cadence estimate.
    if (chain.timestamp && lastSeen !== null && number > lastSeen) {
      const gap = (Number(block.timestamp) - chain.timestamp) / (number - lastSeen)
      if (gap > 0 && gap < 120) chain.interval = chain.interval * 0.7 + gap * 0.3
    }
    if (!current()) return
    lastSeen = number
    chain.head = number
    if (!current()) return
    chain.timestamp = Number(block.timestamp)
    if (!current()) return
    chain.landedAt = Date.now()
    if (!current()) return
    for (const fn of onBlockListeners) {
      if (!current()) break
      fn(number)
    }
  } catch (err: any) {
    if (current()) chain.error = err?.shortMessage ?? err?.message ?? String(err)
  }
}

/**
 * The gallery view looks on its own beat, whatever the setting: it is a
 * screen left up to watch the canvas move, and the owner set ten seconds
 * there (2026-09-29, first three). Everywhere else the setting holds, and
 * never below one momentum.
 */
let override: number | null = null

export function setBeat(seconds: number | null) {
  override = seconds
  refreshNow()
}

function arm(selected: number) {
  if (armGeneration !== selected || hidden()) return
  clearTimeout(timer)
  timer = undefined
  const every = override ?? (prefs.refresh ? Math.max(15, prefs.refresh) : 0)
  if (!every) return
  timer = window.setTimeout(async () => {
    if (armGeneration !== selected || hidden()) return
    timer = undefined
    await poll()
    arm(selected)
  }, every * 1000)
}

/** Looks now, then on the configured beat. Returns the current shared read. */
export function refreshNow() {
  const selected = ++armGeneration
  clearTimeout(timer)
  timer = undefined
  const pending = poll()
  void pending.then(() => arm(selected))
  return pending
}

export function startChainPolling() {
  if (started) return
  started = true
  refreshNow()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      generation++
      reading = null
      armGeneration++
      clearTimeout(timer)
      timer = undefined
    } else refreshNow()
  })
}

watch(() => prefs.refresh, refreshNow)

// RPC, chain identity and health all delimit a heartbeat owner.
watch(
  () => [endpoint.rpc, endpoint.chainId, endpoint.health],
  () => {
    const selected = ++generation
    reading = null
    lastSeen = null
    for (const [key, value] of Object.entries({chainId: null, head: null, timestamp: null,
      baseFee: null, interval: 15, landedAt: Date.now(), error: null})) {
      if (generation !== selected) return
      Object.assign(chain, {[key]: value})
    }
    if (generation === selected) return refreshNow()
  },
  {flush: 'sync'},
)
