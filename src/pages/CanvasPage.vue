<script setup lang="ts">
// The canvas page: tools on the left, the canvas in the middle, colour, tool
// settings, the draft and the activity on the right. On a phone the tools are
// a row above the canvas and the panels stack below it.
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {useRouter} from 'vue-router'
import Board from '../components/Board.vue'
import ToolRail from '../components/ToolRail.vue'
import ColorPicker from '../components/ColorPicker.vue'
import Fold from '../components/Fold.vue'
import ToolOptions from '../components/ToolOptions.vue'
import PaintPanel from '../components/PaintPanel.vue'
import ActivityPanel from '../components/ActivityPanel.vue'
import ImportDialog from '../components/ImportDialog.vue'
import ShortcutsDialog from '../components/ShortcutsDialog.vue'
import Icon from '../components/Icon.vue'
import {axis, chooseTool, prefs, swapColors, TOOLS, type RailAction} from '../core/prefs'
import {redo, undo, draftState} from '../core/draft'
import {submission, submitDraft} from '../core/paint'
import {imageFromPaste, stamp} from '../core/image'
import {board, exportPng, type Paint} from '../core/board'
import {wallet} from '../core/wallet'
import {toast} from '../core/toast'
import {toHex} from '../core/color'
import {compact} from '../core/format'

const currentTool = computed(() => TOOLS.find((t) => t.id === prefs.tool)!)

const view = ref<InstanceType<typeof Board> | null>(null)
const importing = ref(false)
const importFile = ref<File | null>(null)
const keys = ref(false)

function openImport(file: File | null = null) {
  importFile.value = file
  importing.value = true
}

function closeImport() {
  importing.value = false
  importFile.value = null
}

function mirror(which: 'x' | 'y') {
  const on = which === 'x' ? !prefs.mirrorX : !prefs.mirrorY
  if (on && view.value) {
    const c = view.value.centre()
    if (which === 'x') axis.x = c.x
    else axis.y = c.y
  }
  if (which === 'x') prefs.mirrorX = on
  else prefs.mirrorY = on
}

function act(name: RailAction) {
  const v = view.value
  if (name === 'undo') undo()
  if (name === 'redo') redo()
  if (name === 'import') openImport()
  if (name === 'mirrorX') mirror('x')
  if (name === 'mirrorY') mirror('y')
  if (name === 'fit') v?.fit()
  if (name === 'zoomIn') v?.zoomIn()
  if (name === 'zoomOut') v?.zoomOut()
  if (name === 'keys') keys.value = true
}

function locate(p: Paint) {
  view.value?.locate(p)
}

// The view (x, y, z) is in the address bar, written there with replaceState,
// so it is read from there rather than from the router's stale copy.
const pageRouter = useRouter()
const openGallery = () => pageRouter.push({path: '/gallery', query: Object.fromEntries(new URLSearchParams(location.search))})

/** Stats start folded on every visit: open, they cover the draft. */
const statsOpen = ref(false)

/**
 * The right-hand column, on a desk: folded to a slim bar by default, so the
 * canvas has the width, and unfolded when someone wants to draft. The owner's
 * call (2026-09-29). Every visit starts folded. The bar's buttons unfold it
 * straight to what they show.
 */
const sideOpen = ref(false)
function unfold(to?: 'draft' | 'color' | 'stats') {
  sideOpen.value = true
  if (to === 'color') prefs.open.color = true
  if (to === 'stats') statsOpen.value = true
  if (to === 'draft') statsOpen.value = false
}

// Flying to a paint from the list folds the stats on a desk, where they
// cover the column, so the draft is back beside the canvas that just moved.
function onLocate(p: Paint) {
  locate(p)
  if (window.matchMedia('(min-width: 1024px)').matches) statsOpen.value = false
}

const typing = (e: Event) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

function onKey(e: KeyboardEvent) {
  if (typing(e) || document.querySelector('dialog[open]')) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    return e.shiftKey ? redo() : undo()
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    return redo()
  }
  if (mod) return
  if (e.key === ' ') {
    e.preventDefault()
    view.value?.setSpace(true)
    return
  }
  const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase())
  if (tool && !e.shiftKey) return chooseTool(tool.id)
  switch (e.key) {
    case 'x':
    case 'X':
      return swapColors()
    case '[':
      return (prefs.size = Math.max(1, prefs.size - 1))
    case ']':
      return (prefs.size = Math.min(32, prefs.size + 1))
    case '+':
    case '=':
      return view.value?.zoomIn()
    case '-':
    case '_':
      return view.value?.zoomOut()
    case '0':
      return view.value?.fit()
    case 'm':
      return mirror('x')
    case 'M':
      return mirror('y')
    case 'v':
    case 'V':
      return (prefs.showDraft = !prefs.showDraft)
    case '#':
      return (prefs.grid = !prefs.grid)
    case 'p':
    case 'P':
      return (sideOpen.value = !sideOpen.value)
    case '?':
      return (keys.value = true)
    case 'Escape':
      stamp.value = null
      return
    case 'Enter':
      if (wallet.address && draftState.changed && !submission.running) submitDraft({signEach: prefs.signEach}).catch((err) => toast(err?.message ?? String(err), 'bad'))
      return
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === ' ') view.value?.setSpace(false)
}

function onPaste(e: ClipboardEvent) {
  if (typing(e)) return
  const f = imageFromPaste(e)
  if (!f) return
  e.preventDefault()
  openImport(f)
}

async function download() {
  const blob = await exportPng()
  if (!blob) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `mozaic-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

async function share() {
  try {
    await navigator.clipboard.writeText(location.href)
    toast('A link to this view is on your clipboard.', 'good')
  } catch {
    toast('The browser would not copy. The address bar has the link.', 'info')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('paste', onPaste)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('paste', onPaste)
})

const centre = () => view.value?.centre() ?? {x: 500, y: 500}
</script>

<template>
  <div class="studio">
    <ToolRail class="studio-rail" @action="act" />

    <div class="studio-board grid grid-rows-[minmax(0,1fr)_auto] gap-2 min-h-0">
      <Board ref="view" class="min-h-0" @drop-image="openImport" />
      <div class="flex flex-wrap items-center gap-2 text-[12px] text-dim">
        <span>Draw freely: nothing is paid until you press Paint.</span>
        <span class="grow" />
        <button class="btn btn-sm btn-quiet" :disabled="board.status !== 'ready'" title="Download the canvas as a PNG" @click="download">
          <Icon name="download" :size="13" /> PNG
        </button>
        <button class="btn btn-sm btn-quiet" title="Copy a link to this view" @click="share"><Icon name="link" :size="13" /> Link</button>
        <button class="btn btn-sm btn-quiet" title="The canvas alone, full screen, refreshing every 10 seconds" data-testid="gallery" @click="openGallery">
          <Icon name="expand" :size="13" /> Gallery
        </button>
      </div>
    </div>

    <aside class="studio-side min-h-0" :class="{folded: !sideOpen}" data-testid="side">
      <!-- Folded, on a desk: a slim bar. Each button unfolds the column to what it shows. -->
      <nav class="side-rail panel" aria-label="Panels" title="Show the panels (P)" @click="unfold()">
        <button class="rail-btn" title="Show the panels (P)" data-testid="side-open" @click.stop="unfold()">
          <Icon name="panelRight" :size="17" />
        </button>
        <span class="rail-sep" />
        <button class="rail-btn relative" :title="draftState.size ? `Your draft: ${draftState.changed.toLocaleString()} pixels to paint` : 'Your draft'" @click.stop="unfold('draft')">
          <Icon name="brush" :size="17" />
          <span v-if="draftState.changed" class="rail-badge mono">{{ draftState.changed > 999 ? compact(draftState.changed) : draftState.changed }}</span>
          <span v-if="submission.running || draftState.pending" class="rail-live dot live-dot" />
        </button>
        <button class="rail-btn" :title="`Colour ${toHex(prefs.primary)}`" @click.stop="unfold('color')">
          <span class="relative w-[22px] h-[18px]">
            <span class="swatch-mini !w-[14px] !h-[14px] right-0 bottom-0" :style="{background: toHex(prefs.secondary)}" />
            <span class="swatch-mini !w-[14px] !h-[14px] left-0 top-0" :style="{background: toHex(prefs.primary)}" />
          </span>
        </button>
        <button class="rail-btn" title="Stats" @click.stop="unfold('stats')">
          <Icon name="chart" :size="17" />
        </button>
      </nav>

      <div class="side-body">
      <div class="side-scroll grid content-start gap-3">
      <section class="panel p-3.5"><PaintPanel /></section>
      <Fold title="Colour" :open="prefs.open.color" @toggle="prefs.open.color = !prefs.open.color">
        <template #summary>
          <span class="mono text-[12px] text-dim uppercase">{{ toHex(prefs.primary) }}</span>
          <span class="relative w-[30px] h-[22px] shrink-0">
            <span class="swatch-mini right-0 bottom-0" :style="{background: toHex(prefs.secondary)}" />
            <span class="swatch-mini left-0 top-0" :style="{background: toHex(prefs.primary)}" />
          </span>
        </template>
        <ColorPicker />
      </Fold>
      <Fold :title="currentTool.label" :open="prefs.open.tool" @toggle="prefs.open.tool = !prefs.open.tool">
        <template #summary>
          <span class="text-[12px] text-dim">{{ prefs.tool === 'brush' || prefs.tool === 'eraser' || prefs.tool === 'spray' ? `${prefs.size} px` : '' }}</span>
          <span class="kbd">{{ currentTool.key }}</span>
        </template>
        <ToolOptions />
      </Fold>
      </div>

      <!-- Stats: a bar at the foot of the column, folded. Opened, it rises to
           cover the whole column, so the lists get every row of it; folded
           again, it sinks back to the foot. -->
      <section class="stats panel" :class="{open: statsOpen}" data-testid="stats">
        <button class="stats-head" :aria-expanded="statsOpen" aria-controls="stats-body" data-testid="stats-toggle" @click="statsOpen = !statsOpen">
          <span class="font-semibold text-[14px] tracking-[-0.01em]">Stats</span>
          <span class="grow min-w-0 flex items-center justify-end gap-2 text-[12px] text-dim">
            <span class="dot live-dot" style="background: var(--znn-ink)" />
            <span class="mono truncate">{{ board.painted === null ? '' : `${compact(Number(board.painted))} painted` }}</span>
          </span>
          <Icon name="up" :size="15" class="stats-chev text-dim" />
        </button>
        <div id="stats-body" class="stats-body" :inert="!statsOpen">
          <ActivityPanel @locate="onLocate" />
        </div>
      </section>
      <!-- Below Stats, at the foot of the column, where it stays in reach even with Stats risen. -->
      <button class="side-hide" title="Fold the panels away (P)" data-testid="side-close" @click="sideOpen = false">
        Hide panels <Icon name="right" :size="14" />
      </button>
      </div>
    </aside>

    <ImportDialog :open="importing" :file="importFile" :at="centre()" @close="closeImport" />
    <ShortcutsDialog :open="keys" @close="keys = false" />
  </div>
</template>

<style scoped>
/* A phone: the tools scroll in a row, the canvas takes most of the screen,
   and the panels follow it down the page. */
.studio {
  display: grid;
  gap: 12px;
  grid-template-columns: minmax(0, 1fr);
}
.studio-board {
  height: 68vh;
  height: 68dvh;
}

/* A folded colour panel's header still shows the colours in hand. */
.swatch-mini {
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 2px solid var(--surface);
  box-shadow: 0 0 0 1px var(--line-strong);
}

/* A desk: the canvas fills the window between the header and the footer, and
   only the side column scrolls. */
@media (min-width: 1024px) {
  .studio {
    grid-template-columns: auto minmax(0, 1fr) var(--side-w);
    /* The canvas takes the width the column gives up, and gives it back, on
       one easing: the board's ResizeObserver keeps it covering as it moves. */
    transition: grid-template-columns 420ms var(--ease-out);
    height: calc(100dvh - 118px);
  }
  .studio-board {
    height: auto;
  }
  .studio-rail {
    align-self: start;
  }
  /* The column is a frame: the panels scroll inside it above the stats bar,
     and the stats sit over them, pinned to the foot until opened.

     Scrolls down, never across. overflow-y: auto makes overflow-x auto too,
     so one unbreakable line in a panel (a session's progress, at a full
     canvas) grew a sideways scrollbar under the whole column. Children may
     shrink to the column, and anything still too wide is clipped. */
  .studio-side {
    position: relative;
  }
  .side-scroll {
    position: absolute;
    inset: 0 0 calc(var(--stats-bar) + var(--hide-bar) + 16px) 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 2px;
    scrollbar-width: thin;
  }
  .side-scroll > * {
    min-width: 0;
  }
  /* One column exactly as wide as the side, not as wide as its widest child.
     An implicit grid column is sized to content, so a session's step line
     ("Paint 15,000 pixels in 2 batches" beside its chip) widened it to 356 px
     in a 330 px side, and the right edge of every panel was clipped. */
  .side-scroll {
    grid-template-columns: minmax(0, 1fr);
  }
  /* Anchored at the foot, and grown by moving its top: from one bar's height
     above the foot to the top of the column. */
  .stats {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(var(--hide-bar) + 4px);
    top: calc(100% - var(--stats-bar) - var(--hide-bar) - 4px);
    z-index: 5;
    /* Opaque: every other panel is glass, and open, this one lies over them.
       Through glass the draft read through the list. */
    background: var(--surface);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: top 460ms var(--ease-out), box-shadow 300ms var(--ease);
  }
  .stats.open {
    top: 0;
    box-shadow: var(--edge), var(--shadow-pop);
  }
  .stats-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
}

.studio {
  --stats-bar: 46px;
  --hide-bar: 26px;
  --side-w: 330px;
}
.studio:has(.studio-side.folded) {
  --side-w: 52px;
}
.side-rail,
.side-hide {
  display: none;
}

@media (min-width: 1024px) {
  /* The column's content is laid out at its full width whether or not the
     column is, and clipped: unfolding reveals it rather than reflowing it
     at every width on the way. */
  .studio-side {
    overflow: hidden;
  }
  .side-body {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 330px;
    transition: opacity 260ms var(--ease), transform 420ms var(--ease-out);
  }
  .studio-side.folded .side-body {
    opacity: 0;
    transform: translateX(24px);
    pointer-events: none;
    visibility: hidden;
    transition: opacity 180ms var(--ease), transform 420ms var(--ease-out), visibility 0s 180ms;
  }
  .side-rail {
    cursor: pointer;
    position: absolute;
    inset: 0 0 0 auto;
    width: 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 0;
    transition: opacity 200ms var(--ease);
  }
  .studio-side:not(.folded) .side-rail {
    opacity: 0;
    pointer-events: none;
  }
  .side-hide {
    position: absolute;
    right: 0;
    bottom: 0;
    height: var(--hide-bar);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--dim);
    padding: 2px 4px;
    border-radius: var(--radius);
    transition: color 150ms var(--ease);
  }
  .side-hide:hover {
    color: var(--fg);
  }
}
.rail-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 36px;
  border-radius: 7px;
  color: var(--dim);
  transition: color 150ms var(--ease), background 150ms var(--ease);
}
.rail-btn:hover {
  color: var(--fg);
  background: var(--raised);
}
.rail-sep {
  width: 24px;
  height: 1px;
  margin: 2px 0;
  background: var(--line);
}
.rail-badge {
  position: absolute;
  top: 1px;
  right: -2px;
  min-width: 16px;
  height: 15px;
  padding: 0 3px;
  border-radius: 99px;
  font-size: 9.5px;
  line-height: 15px;
  text-align: center;
  color: #04140a;
  background: var(--znn);
}
.rail-live {
  position: absolute;
  bottom: 3px;
  right: 5px;
  background: var(--nom-ink);
}
.stats-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: var(--stats-bar);
  flex: none;
  padding: 0 14px;
  text-align: left;
  border-radius: var(--radius);
  transition: background 150ms var(--ease);
}
.stats-head:hover {
  background: color-mix(in srgb, var(--fg) 4%, transparent);
}
.stats-body {
  padding: 0 14px 14px;
}
.stats-chev {
  transition: transform 300ms var(--ease-out);
}
.stats.open .stats-chev {
  transform: rotate(180deg);
}
/* A phone stacks the panels, so there the stats are an ordinary fold. */
@media (max-width: 1023px) {
  .stats:not(.open) .stats-body {
    display: none;
  }
}
</style>
