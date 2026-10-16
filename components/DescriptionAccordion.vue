<script setup lang="ts">
const props = defineProps<{
  text: string
}>()

const { t } = useI18n()
const copy = ref<HTMLElement | null>(null)
const expanded = ref(false)
const collapsible = ref(false)
const measured = ref(false)
let observer: ResizeObserver | null = null

/** Recomputes whether the rendered copy exceeds the always-visible ten lines. */
function measure() {
  const el = copy.value
  if (!el || typeof window === 'undefined') return
  const style = window.getComputedStyle(el)
  let lineHeight = Number.parseFloat(style.lineHeight)
  if (!Number.isFinite(lineHeight)) {
    const fontSize = Number.parseFloat(style.fontSize)
    lineHeight = Number.isFinite(fontSize) ? fontSize * 1.625 : 26
  }
  collapsible.value = el.scrollHeight > lineHeight * 10 + 1
  if (!collapsible.value) expanded.value = false
  measured.value = true
}

watch(() => props.text, async () => {
  expanded.value = false
  measured.value = false
  await nextTick()
  measure()
})

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(measure)
  if (copy.value) observer.observe(copy.value)
})

onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div>
    <p
      id="auction-description"
      ref="copy"
      class="whitespace-pre-line break-words text-sm leading-[1.625] text-foreground/90 [overflow-wrap:anywhere]"
      :class="{ 'max-h-[16.25em] overflow-hidden': !expanded && (!measured || collapsible) }"
    >
      {{ text }}
    </p>
    <Button
      v-if="collapsible"
      type="button"
      variant="ghost"
      size="sm"
      class="mt-2 px-0 text-primary hover:bg-transparent hover:text-primary/80"
      :aria-expanded="expanded"
      aria-controls="auction-description"
      @click="expanded = !expanded"
    >
      {{ t(expanded ? 'objektDetail.showLessDescription' : 'objektDetail.showMoreDescription') }}
    </Button>
  </div>
</template>
