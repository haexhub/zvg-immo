<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { DialogOverlay, type DialogOverlayProps } from 'reka-ui'
import { cn } from '~/lib/utils'

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes['class'] }>()
const delegated = computed(() => {
  const { class: _c, ...rest } = props
  return rest
})
</script>

<template>
  <DialogOverlay
    v-bind="delegated"
    :class="cn(
      'fixed inset-0 z-50 bg-black/40',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      props.class,
    )"
  />
</template>
