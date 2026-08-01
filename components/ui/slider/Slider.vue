<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { SliderRootEmits, SliderRootProps } from "reka-ui"
import { useVModel } from "@vueuse/core"
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from "reka-ui"
import { cn } from "@/lib/utils"

const props = withDefaults(
  defineProps<SliderRootProps & { class?: HTMLAttributes["class"] }>(),
  {
    modelValue: () => [0],
  },
)

const emits = defineEmits<SliderRootEmits>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.modelValue ?? [0],
})
</script>

<template>
  <SliderRoot
    data-slot="slider"
    v-model="modelValue"
    :class="cn(
      'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
      props.class,
    )"
  >
    <SliderTrack
      data-slot="slider-track"
      class="bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
    >
      <SliderRange
        data-slot="slider-range"
        class="bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
      />
    </SliderTrack>
    <SliderThumb
      v-for="(_, key) in modelValue"
      :key="key"
      data-slot="slider-thumb"
      class="border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-colors hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderRoot>
</template>
