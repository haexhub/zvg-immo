<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  SelectScrollUpButton,
  SelectScrollDownButton,
  type SelectContentEmits,
  type SelectContentProps,
  useForwardPropsEmits,
} from 'reka-ui'
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import { cn } from '~/lib/utils'

const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(),
  { position: 'popper' },
)
const emits = defineEmits<SelectContentEmits>()

const delegated = computed(() => {
  const { class: _c, ...rest } = props
  return rest
})
const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <SelectPortal>
    <SelectContent
      v-bind="forwarded"
      :class="cn(
        'relative z-50 max-h-[var(--reka-select-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
        props.class,
      )"
    >
      <SelectScrollUpButton class="flex h-6 cursor-default items-center justify-center">
        <ChevronUp class="size-4" />
      </SelectScrollUpButton>
      <SelectViewport
        :class="cn(
          'p-1',
          position === 'popper' && 'w-full min-w-[var(--reka-select-trigger-width)] scroll-my-1',
        )"
      >
        <slot />
      </SelectViewport>
      <SelectScrollDownButton class="flex h-6 cursor-default items-center justify-center">
        <ChevronDown class="size-4" />
      </SelectScrollDownButton>
    </SelectContent>
  </SelectPortal>
</template>
