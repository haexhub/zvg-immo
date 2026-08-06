<script setup lang="ts">
// Trigger + Popover for one segment of the Airbnb-style search bar (see
// SearchBar.vue). Desktop-only — below the `md` breakpoint SearchBar.vue
// renders a single combined bar with a tabbed Sheet instead, since a
// fixed-width floating Popover has nowhere to go on a narrow viewport.
defineProps<{
  label: string
  summary: string
  align?: 'start' | 'end'
}>()

const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <Popover v-model:open="open">
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
</template>
