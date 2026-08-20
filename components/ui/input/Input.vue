<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

// Manual v-model wiring (rather than VueUse's useVModel straight onto a
// native v-model) so `v-model.lazy`/`.number` on this component actually do
// something — Vue only applies modifiers a custom component's own template
// acts on, and forwarding to an unmodified inner `<input v-model>` silently
// dropped them. `.number` maps an emptied field to `null` (not `0`/`''`)
// since every current numeric consumer is a `number | null` ref.
const props = withDefaults(
  defineProps<{
    defaultValue?: string | number
    modelValue?: string | number | null
    modelModifiers?: { lazy?: boolean; number?: boolean; trim?: boolean }
    class?: HTMLAttributes["class"]
  }>(),
  { modelModifiers: () => ({}) },
)

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number | null): void
}>()

function handleChange(event: Event): void {
  let value: string | number | null = (event.target as HTMLInputElement).value
  if (props.modelModifiers.trim) value = (value as string).trim()
  if (props.modelModifiers.number) {
    const n = Number(value)
    value = value === '' ? null : Number.isNaN(n) ? value : n
  }
  emits("update:modelValue", value)
}
</script>

<template>
  <input
    :value="modelValue === undefined ? props.defaultValue : modelValue"
    data-slot="input"
    :class="cn(
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
      'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3',
      'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
      '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]',
      props.class,
    )"
    @input="!modelModifiers.lazy && handleChange($event)"
    @change="modelModifiers.lazy && handleChange($event)"
  >
</template>
