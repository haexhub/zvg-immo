<script setup lang="ts">
// A Select-styled trigger box (same look as components/ui/select) that opens
// a checkbox list instead of picking one value — used by
// SearchPropertiesPopover for Zustand/Ausstattung, both of which need "any of
// several" rather than a single choice.
import { ChevronDown } from 'lucide-vue-next'
import { toggleInArray } from '~/lib/toggle-array'

const props = defineProps<{
  options: Array<{ value: string; label: string }>
  placeholder: string
}>()

const modelValue = defineModel<string[]>({ required: true })
const open = ref(false)
const { t } = useI18n()

const summary = computed(() => {
  if (modelValue.value.length === 0) return props.placeholder
  if (modelValue.value.length <= 2) {
    return modelValue.value
      .map((v) => props.options.find((o) => o.value === v)?.label ?? v)
      .join(', ')
  }
  return t('filters.selectedCount', { count: modelValue.value.length })
})

function toggle(value: string): void {
  modelValue.value = toggleInArray(modelValue.value, value)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="border-input flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none"
        :class="open ? 'border-ring ring-ring/50 ring-3' : ''"
      >
        <span class="truncate" :class="modelValue.length === 0 ? 'text-muted-foreground' : ''">{{ summary }}</span>
        <ChevronDown class="size-4 shrink-0 opacity-50" />
      </button>
    </PopoverTrigger>
    <PopoverContent class="w-(--reka-popover-trigger-width) p-1" align="start">
      <div class="max-h-64 overflow-y-auto">
        <label
          v-for="o in options"
          :key="o.value"
          class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-muted"
        >
          <Checkbox :model-value="modelValue.includes(o.value)" @update:model-value="toggle(o.value)" />
          {{ o.label }}
        </label>
      </div>
    </PopoverContent>
  </Popover>
</template>
