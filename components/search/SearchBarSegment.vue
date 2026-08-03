<script setup lang="ts">
// Shared trigger + container for one segment of the Airbnb-style search bar
// (see SearchBar.vue). A fixed-width floating Popover has nowhere to go on a
// narrow viewport and ends up clipped off the edge of the screen, so below
// the `md` breakpoint this renders the same content as a fullscreen bottom
// Sheet instead.
import { useMediaQuery } from '@vueuse/core'

defineProps<{
  label: string
  summary: string
  align?: 'start' | 'end'
}>()

const open = defineModel<boolean>('open', { required: true })
// ssrWidth assumes desktop for the server render (this component's prior,
// popover-only behavior) — cuts the hydration mismatch on desktop, where
// SSR and client now agree; mobile still corrects itself right after mount.
const isDesktop = useMediaQuery('(min-width: 768px)', { ssrWidth: 1280 })
</script>

<template>
  <Popover v-if="isDesktop" v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="min-w-0 flex-1 rounded-full px-4 py-2 text-left transition-colors"
        :class="open ? 'bg-background shadow' : 'hover:bg-background/60'"
      >
        <span class="block text-xs font-semibold">{{ label }}</span>
        <span class="block truncate text-sm text-muted-foreground">{{ summary }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent class="w-md p-5" :align="align ?? 'start'">
      <slot />
    </PopoverContent>
  </Popover>

  <Sheet v-else v-model:open="open">
    <SheetTrigger as-child>
      <button
        type="button"
        class="min-w-0 flex-1 rounded-full px-4 py-2 text-left transition-colors"
        :class="open ? 'bg-background shadow' : 'hover:bg-background/60'"
      >
        <span class="block text-xs font-semibold">{{ label }}</span>
        <span class="block truncate text-sm text-muted-foreground">{{ summary }}</span>
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
