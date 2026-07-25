<script setup lang="ts">
const props = defineProps<{
  text: string
}>()

const { t } = useI18n()
const copy = ref<HTMLElement | null>(null)
const expanded = ref(false)
const collapsible = ref(false)
let observer: ResizeObserver | null = null

function measure() {
  const el = copy.value
  if (!el || typeof window === 'undefined') return
  const lineHeight = Number.parseFloat(window.getComputedStyle(el).lineHeight)
  if (!Number.isFinite(lineHeight)) return
  collapsible.value = el.scrollHeight > lineHeight * 10 + 1
  if (!collapsible.value) expanded.value = false
}

watch(() => props.text, async () => {
  expanded.value = false
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
      class="description-copy whitespace-pre-line text-sm text-foreground/90"
      :class="{ 'description-copy--collapsed': collapsible && !expanded }"
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

<style scoped>
.description-copy {
  line-height: 1.625;
}

.description-copy--collapsed {
  max-height: 16.25em;
  overflow: hidden;
}
</style>
