<script setup lang="ts">
// Shared trigger + container for one segment of the Airbnb-style search bar
// (see SearchBar.vue). A fixed-width floating Popover has nowhere to go on a
// narrow viewport and ends up clipped off the edge of the screen, so below
// the `md` breakpoint this renders the same content as a fullscreen bottom
// Sheet instead.
import { useMediaQuery } from '@vueuse/core'

const props = defineProps<{
  label: string
  summary: string
  align?: 'start' | 'end'
  // Collapsed header (see useHeaderCompact): the segment drops its label line
  // and shrinks to a single-line button instead of a full-width input field.
  compact?: boolean
  // Whether `summary` holds a real selection or just its placeholder — the
  // compact button has no room for a placeholder and falls back to `label`.
  hasValue?: boolean
  // Popover width (Tailwind width class) — Properties needs more room than
  // Location/Environment for its two-column number ranges and multi-selects.
  contentClass?: string
}>()

const open = defineModel<boolean>('open', { required: true })
// ssrWidth assumes desktop for the server render (this component's prior,
// popover-only behavior) — cuts the hydration mismatch on desktop, where
// SSR and client now agree; mobile still corrects itself right after mount.
const isDesktop = useMediaQuery('(min-width: 768px)', { ssrWidth: 1280 })

const triggerClass = computed(() => [
  'min-w-0 rounded-full text-left transition-colors',
  // Three full-width segments leave ~85px of text each on a 390px phone, so the
  // large state keeps the tighter padding until there's room for it.
  props.compact ? 'max-w-32 px-4 py-1.5' : 'flex-1 px-4 py-3 sm:px-6',
])
const compactText = computed(() => (props.hasValue ? props.summary : props.label))
</script>

<template>
  <Popover v-if="isDesktop" v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="[triggerClass, open ? 'bg-background shadow' : 'hover:bg-background/60']"
      >
        <span v-if="compact" class="block truncate text-sm font-medium">{{ compactText }}</span>
        <template v-else>
          <span class="block truncate text-sm font-semibold">{{ label }}</span>
          <span class="block truncate text-sm text-muted-foreground">{{ summary }}</span>
        </template>
      </button>
    </PopoverTrigger>
    <PopoverContent :class="contentClass ?? 'w-lg p-5'" :align="align ?? 'start'">
      <slot />
    </PopoverContent>
  </Popover>

  <Sheet v-else v-model:open="open">
    <SheetTrigger as-child>
      <button
        type="button"
        :class="[triggerClass, open ? 'bg-background shadow' : 'hover:bg-background/60']"
      >
        <span v-if="compact" class="block truncate text-sm font-medium">{{ compactText }}</span>
        <template v-else>
          <span class="block truncate text-sm font-semibold">{{ label }}</span>
          <span class="block truncate text-sm text-muted-foreground">{{ summary }}</span>
        </template>
      </button>
    </SheetTrigger>
    <SheetContent side="bottom" class="h-dvh max-h-dvh w-full gap-0 rounded-none border-t-0 p-0">
      <SheetHeader class="border-b">
        <SheetTitle>{{ label }}</SheetTitle>
      </SheetHeader>
      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <slot />
      </div>
    </SheetContent>
  </Sheet>
</template>
