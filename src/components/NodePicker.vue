<script setup lang="ts">
// Which node, which canvas, and how often to look. A first-class control
// rather than a buried setting: on a devnet the node is what changes most, and
// pointing the page at your own node or your own canvas is the normal case.
import {computed, ref, useId, watch} from 'vue'
import {endpoint, setEndpoint, setContract, check, PRESETS, isLoopback, mixedContentBlocked, normalize, ready, deploymentFor} from '../core/endpoint'
import {chain, refreshNow} from '../core/chain'
import {chainName} from '../core/chains'
import {prefs, REFRESH_CHOICES} from '../core/prefs'
import {number, short} from '../core/format'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const open = ref(false)
const rpcId = useId()
const contractId = useId()
const draft = ref(endpoint.rpc)
const contractDraft = ref(endpoint.contract ?? '')
const busy = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  draft.value = endpoint.rpc
  contractDraft.value = endpoint.contract ?? ''
})
watch(
  () => endpoint.contract,
  (c) => (contractDraft.value = c ?? ''),
)

const tone = computed(() => {
  if (busy.value || endpoint.health === 'checking') return 'var(--warn)'
  if (ready.value) return 'var(--znn-ink)'
  if (endpoint.health === 'ok') return 'var(--warn)'
  if (endpoint.health === 'error') return 'var(--danger)'
  return 'var(--dim)'
})

const label = computed(() => {
  if (endpoint.health === 'error') return 'No node'
  if (endpoint.chainId === null) return 'Connecting'
  return chainName(endpoint.chainId)
})

const willBlock = computed(() => mixedContentBlocked(normalize(draft.value)))
const dirty = computed(() => normalize(draft.value) !== endpoint.rpc)
const recorded = computed(() => (endpoint.chainId !== null ? deploymentFor(endpoint.chainId)?.mozaic ?? null : null))

async function use(url: string) {
  busy.value = true
  try {
    draft.value = url
    if ((await setEndpoint(url)) && ready.value) open.value = false
  } finally {
    busy.value = false
  }
}

async function useContract(address: string) {
  busy.value = true
  try {
    await setContract(address)
  } finally {
    busy.value = false
  }
}

async function retry() {
  busy.value = true
  try {
    await check()
  } finally {
    busy.value = false
  }
}

const source = {link: 'from the link', saved: 'chosen here', build: 'built into this page', deployment: 'the recorded deployment'} as const
</script>

<template>
  <div>
    <button class="btn btn-sm" :title="endpoint.rpc" data-testid="node-picker" @click="open = true">
      <span class="dot" :class="endpoint.health === 'checking' ? 'live-dot' : ''" :style="{background: tone}" />
      <span class="text-[12.5px]">{{ label }}</span>
      <Icon name="down" :size="13" class="text-dim" />
    </button>

    <Modal :open="open" title="Node and canvas" :width="480" @close="open = false">
      <div class="p-4 grid gap-4 max-h-[80vh] overflow-auto">
        <form class="grid gap-2" @submit.prevent="use(draft)">
          <label class="ledger" :for="rpcId">JSON-RPC endpoint</label>
          <div class="flex gap-2">
            <input :id="rpcId" data-testid="node-rpc" autofocus v-model="draft" class="input" spellcheck="false" autocomplete="off" placeholder="https://host/rpc" />
            <button class="btn btn-plasma" type="submit" :disabled="busy || !dirty">Use</button>
          </div>
        </form>

        <p v-if="willBlock" class="text-[12.5px] rounded p-2.5" style="background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn)">
          Your browser will block this. An HTTPS page cannot reach plain HTTP, except on loopback.
        </p>

        <div class="grid gap-1.5">
          <span class="ledger">Saved nodes</span>
          <button
            v-for="p in PRESETS"
            :key="p.url"
            class="text-left px-3 py-2 rounded border transition-colors hover:bg-surface"
            :style="{
              borderColor: p.url === endpoint.rpc ? 'color-mix(in srgb, var(--znn) 45%, transparent)' : 'var(--line)',
              background: p.url === endpoint.rpc ? 'color-mix(in srgb, var(--znn) 8%, transparent)' : '',
            }"
            @click="use(p.url)"
          >
            <span class="flex items-center gap-2">
              <span class="text-[13.5px]">{{ p.label }}</span>
              <Icon v-if="p.url === endpoint.rpc" name="check" :size="13" style="color: var(--znn-ink)" />
            </span>
            <span class="block mono text-[11.5px] text-dim">{{ p.url }}</span>
          </button>
        </div>

        <form v-if="endpoint.chainId !== null" class="grid gap-2 border-t border-line pt-3" @submit.prevent="useContract(contractDraft)">
          <label class="ledger" :for="contractId">Mozaic contract</label>
          <div class="flex gap-2">
            <input :id="contractId" data-testid="node-contract" v-model="contractDraft" class="input" spellcheck="false" autocomplete="off" placeholder="0x..." />
            <button class="btn" type="submit" :disabled="busy || contractDraft === (endpoint.contract ?? '')">Use</button>
          </div>
          <p class="text-[12px] text-dim">
            <template v-if="endpoint.contractSource">This one is {{ source[endpoint.contractSource] }}.</template>
            <button v-if="recorded && endpoint.contract?.toLowerCase() !== recorded.toLowerCase()" type="button" class="link ml-1" @click="useContract('')">
              Back to the recorded canvas
            </button>
          </p>
          <p v-if="endpoint.contractError" class="text-[12.5px]" style="color: var(--danger)">{{ endpoint.contractError }}</p>
        </form>

        <div class="grid gap-2 border-t border-line pt-3">
          <span class="ledger">Look for new paints</span>
          <div class="seg self-start">
            <button v-for="c in REFRESH_CHOICES" :key="c.s" :class="{on: prefs.refresh === c.s}" @click="prefs.refresh = c.s">{{ c.label }}</button>
          </div>
          <p class="text-[12px] text-dim">
            One momentum is about {{ Math.round(chain.interval) }} s, so looking more often finds nothing new. Each look is one small request, and a
            hidden tab does not look at all.
            <button v-if="!prefs.refresh" type="button" class="link" @click="refreshNow">Look now</button>
          </p>
        </div>

        <dl class="grid gap-1.5 text-[13px] border-t border-line pt-3">
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Status</dt>
            <dd class="flex items-center gap-1.5">
              <span class="dot" :style="{background: tone}" />
              <span v-if="ready">Reachable, canvas found</span>
              <span v-else-if="endpoint.health === 'ok'" style="color: var(--warn)">Reachable, no canvas</span>
              <span v-else-if="endpoint.health === 'checking' || busy">Checking</span>
              <span v-else-if="endpoint.health === 'error'" style="color: var(--danger)">Not reachable</span>
              <span v-else>Not checked</span>
            </dd>
          </div>
          <div v-if="endpoint.chainId !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Chain</dt>
            <dd class="mono">{{ endpoint.chainId }}</dd>
          </div>
          <div v-if="endpoint.latency !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Round trip</dt>
            <dd class="mono">{{ endpoint.latency }} ms</dd>
          </div>
          <div v-if="chain.head !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Block</dt>
            <dd class="mono">{{ number(chain.head) }}</dd>
          </div>
          <div v-if="endpoint.canvas" class="flex justify-between gap-3">
            <dt class="text-dim">Owner</dt>
            <dd class="mono">{{ short(endpoint.canvas.owner, 8, 6) }}</dd>
          </div>
        </dl>

        <p v-if="endpoint.error" class="text-[13px]" style="color: var(--danger)">
          {{ endpoint.error }}
          <span v-if="endpoint.hint" class="block text-dim mt-1">{{ endpoint.hint }}</span>
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <button class="btn btn-sm" :disabled="busy" @click="retry"><Icon name="refresh" :size="13" /> Check again</button>
          <a v-if="endpoint.apiBase && endpoint.contract" class="btn btn-sm btn-quiet" :href="`${endpoint.apiBase}/address/${endpoint.contract}`" target="_blank" rel="noreferrer noopener">
            <Icon name="external" :size="13" /> The contract on the explorer
          </a>
        </div>

        <p v-if="isLoopback(endpoint.rpc)" class="text-[12px] text-dim border-t border-line pt-3">
          Your browser talks to {{ short(endpoint.rpc, 30, 8) }} directly. Nothing is proxied.
        </p>
      </div>
    </Modal>
  </div>
</template>
