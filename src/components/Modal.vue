<script setup lang="ts">
// A dialog, using the platform's own. <dialog> brings the focus trap, the
// backdrop, Escape to close and inert content behind it, none of which are
// worth reimplementing.
import {onBeforeUnmount, ref, useId, watch} from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{open: boolean; title: string; width?: number}>()
const emit = defineEmits<{(e: 'close'): void}>()

const el = ref<HTMLDialogElement | null>(null)
const titleId = useId()

watch(
  [() => props.open, el],
  ([open, dialog]) => {
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  },
)

// Native close events are queued. The same element can already belong to a
// new opening when an earlier close notification arrives.
function nativeClosed() {
  const dialog = el.value
  if (!props.open || !dialog || dialog.open) return
  emit('close')
}

onBeforeUnmount(() => el.value?.open && el.value.close())
</script>

<template>
  <dialog
    ref="el"
    class="mozaic-dialog"
    :aria-labelledby="titleId"
    :style="{width: `${width ?? 420}px`}"
    @close="nativeClosed"
    @click.self="emit('close')"
  >
    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
      <h2 :id="titleId" class="text-[15px] font-semibold tracking-[-0.01em]">{{ title }}</h2>
      <button class="btn btn-sm btn-quiet px-1.5" title="Close" @click="emit('close')">
        <Icon name="x" :size="15" />
        <span class="sr-only">Close</span>
      </button>
    </div>
    <div class="min-h-0"><slot /></div>
  </dialog>
</template>

<style scoped>
.mozaic-dialog {
  margin: auto;
  max-width: 94vw;
  max-height: 86vh;
  padding: 0;
  overflow: hidden;
  color: var(--fg);
  background: var(--raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  box-shadow: var(--edge), var(--shadow-pop);
}

/* Every dialog's body is a grid, and an implicit grid column is sized to its
   content. A full 42-character address in the account dialog made that column
   wider than the dialog, so the right edge (balance, Copy, Disconnect) was
   clipped rather than the address truncated. Capping the column at the
   dialog's width lets `truncate` and wrapping do their job. */
.mozaic-dialog :slotted(.grid:not([class*='grid-cols'])) {
  grid-template-columns: minmax(0, 1fr);
}

.mozaic-dialog::backdrop {
  background: rgb(2 6 7 / 0.66);
  backdrop-filter: blur(3px);
}

.mozaic-dialog[open] {
  animation: dialog-in 160ms var(--ease);
}

@keyframes dialog-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
