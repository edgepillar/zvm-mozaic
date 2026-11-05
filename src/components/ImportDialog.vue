<script setup lang="ts">
// Bringing a picture in: choose its width in canvas pixels, see what that
// costs, then either hold it as a stamp to click into the draft, or pin it
// over the canvas as a guide to trace.
import {computed, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import {decode, disposeDecoded, guide, pixelsOf, scaled, stamp, type Decoded, type Picture} from '../core/image'
import {endpoint} from '../core/endpoint'
import {number, units} from '../core/format'
import Modal from './Modal.vue'
import Icon from './Icon.vue'

const props = defineProps<{open: boolean; file: File | null; at: {x: number; y: number}}>()
const emit = defineEmits<{(e: 'close'): void}>()

const bitmap = shallowRef<Decoded | null>(null)
const name = ref('')
const width = ref(64)
const error = ref('')
const input = ref<HTMLInputElement | null>(null)
const previewEl = ref<HTMLCanvasElement | null>(null)

let generation = 0
let disposed = false
let reading: AbortController | null = null
const owns = (ticket: number) => !disposed && props.open && ticket === generation

function retire() {
  generation++
  reading?.abort()
  reading = null
  const previous = bitmap.value
  bitmap.value = null
  disposeDecoded(previous)
  name.value = ''
  width.value = 64
  error.value = ''
}

async function load(f: File) {
  if (disposed || !props.open) return
  retire()
  const ticket = generation
  const request = new AbortController()
  reading = request
  try {
    const next = await decode(f, request.signal)
    if (!owns(ticket)) {disposeDecoded(next); return}
    bitmap.value = next
    if (!owns(ticket)) return
    name.value = f.name || 'Pasted image'
    if (!owns(ticket)) return
    // A full-size photo can be a million pixels; start with a small stamp.
    width.value = Math.min(next.width, 128)
  } catch (err: any) {
    if (!owns(ticket)) return
    const previous = bitmap.value
    bitmap.value = null
    disposeDecoded(previous)
    if (!owns(ticket)) return
    error.value = err?.message ?? 'That image could not be read.'
  } finally {
    if (reading === request) reading = null
  }
}

// Clear stale input at the first prop change. Actions wait until the parent
// has patched both open and file, and the native dialog has been updated.
watch(() => [props.open, props.file] as const, retire, {flush: 'sync'})
watch(
  () => [props.open, props.file] as const,
  ([open, file]) => {
    if (disposed || !open) return
    if (file) void load(file)
    else input.value?.click()
  },
  {immediate: true, flush: 'post'},
)
onBeforeUnmount(() => {disposed = true; retire()})

const picture = computed<Picture | null>(() => (bitmap.value ? scaled(bitmap.value, width.value, name.value) : null))
const pixels = computed(() => (picture.value ? pixelsOf(picture.value).length : 0))

watch([picture, previewEl], ([p, el]) => {
  if (!p || !el) return
  const k = Math.min(1, 240 / Math.max(p.w, p.h)) * Math.max(1, Math.floor(240 / Math.max(p.w, p.h)))
  el.width = Math.round(p.w * k)
  el.height = Math.round(p.h * k)
  const c = el.getContext('2d')!
  c.imageSmoothingEnabled = false
  c.drawImage(p.canvas, 0, 0, el.width, el.height)
})

function asStamp() {
  const pictureToPlace = picture.value
  const ticket = generation
  if (!owns(ticket) || !pictureToPlace) return
  stamp.value = pictureToPlace
  if (owns(ticket)) finish()
}

function asGuide() {
  const pictureToPlace = picture.value
  const ticket = generation
  if (!owns(ticket) || !pictureToPlace) return
  guide.picture = pictureToPlace
  if (!owns(ticket)) return
  guide.x = Math.max(0, Math.round(props.at.x - pictureToPlace.w / 2))
  if (!owns(ticket)) return
  guide.y = Math.max(0, Math.round(props.at.y - pictureToPlace.h / 2))
  if (!owns(ticket)) return
  guide.visible = true
  if (owns(ticket)) finish()
}

function finish() {
  retire()
  if (!disposed) emit('close')
}

function pick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) load(f)
  ;(e.target as HTMLInputElement).value = ''
}

const maxWidth = computed(() => Math.min(1000, Math.max(8, bitmap.value?.width ?? 1000) * 4))
</script>

<template>
  <Modal :open="open" title="Bring in an image" :width="460" @close="finish">
    <div class="p-4 grid gap-4 text-[13px]">
      <input ref="input" type="file" accept="image/*,.ico,.cur,.svg,.avif,.webp" class="hidden" data-testid="image-input" @change="pick" />

      <button v-if="!bitmap" class="drop grid place-items-center gap-2 py-10 text-dim" @click="input?.click()">
        <Icon name="upload" :size="22" />
        <span>Choose an image, drop one on the canvas, or paste one with Ctrl+V</span>
      </button>

      <template v-else>
        <div class="grid place-items-center rounded-md p-3 checker">
          <canvas ref="previewEl" class="max-w-full" style="image-rendering: pixelated" />
        </div>
        <label class="grid gap-1.5">
          <span class="flex justify-between"
            ><span class="text-dim">Width on the canvas</span><span class="mono">{{ picture?.w }} x {{ picture?.h }} px</span></span
          >
          <input
            v-model.number="width"
            type="range"
            min="4"
            :max="maxWidth"
            class="range"
            :style="{'--fill': `${(width / maxWidth) * 100}%`}"
            data-testid="image-width"
          />
        </label>
        <p class="text-dim">
          {{ number(pixels) }} pixels. Painted whole, about
          <span class="mono text-fg">{{ endpoint.canvas ? units(endpoint.canvas.price * BigInt(pixels), 18, 4) : '-' }} ZNN</span> plus fees, less
          wherever the canvas already has the colour. Transparent parts are left alone.
        </p>
        <div class="grid grid-cols-2 gap-2">
          <button class="btn btn-plasma" data-testid="as-stamp" @click="asStamp"><Icon name="brush" :size="14" /> Stamp into draft</button>
          <button class="btn" @click="asGuide"><Icon name="pin" :size="14" /> Pin as a guide</button>
        </div>
        <p class="text-[12px] text-dim">
          A stamp follows the pointer until you click where it goes. A guide sits over the canvas, see-through and free, for tracing by
          hand; move it from the tool panel.
        </p>
      </template>
      <p v-if="error" style="color: var(--danger)">{{ error }}</p>
    </div>
  </Modal>
</template>

<style scoped>
.drop {
  border: 1.5px dashed var(--line-strong);
  border-radius: var(--radius);
  transition: border-color 150ms var(--ease), color 150ms var(--ease);
}
.drop:hover {
  border-color: var(--znn-ink);
  color: var(--fg);
}
.checker {
  background: repeating-conic-gradient(var(--sunk) 0 25%, var(--raised) 0 50%) 0 0 / 16px 16px;
}
</style>
