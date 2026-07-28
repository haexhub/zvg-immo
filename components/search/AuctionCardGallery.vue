<script setup lang="ts">
import { A11y, Navigation, Pagination } from 'swiper/modules'
import { Swiper, SwiperSlide } from 'swiper/vue'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import 'swiper/css/a11y'

const props = defineProps<{
  photos: string[]
  altBase: string
}>()

const { t } = useI18n()
const swiperModules = [A11y, Navigation, Pagination]

type SwiperLike = {
  activeIndex?: number
  realIndex?: number
}

const requestedIndexes = ref<Set<number>>(new Set([0]))
const loadedIndexes = ref<Set<number>>(new Set())
const failedIndexes = ref<Set<number>>(new Set())

function replaceSet(source: Set<number>, mutate: (next: Set<number>) => void): Set<number> {
  const next = new Set(source)
  mutate(next)
  return next
}

function requestPhoto(index: number): void {
  if (index < 0 || index >= props.photos.length) return
  if (requestedIndexes.value.has(index)) return
  requestedIndexes.value = replaceSet(requestedIndexes.value, (next) => next.add(index))
}

function requested(index: number): boolean {
  return requestedIndexes.value.has(index)
}

function loaded(index: number): boolean {
  return loadedIndexes.value.has(index)
}

function failed(index: number): boolean {
  return failedIndexes.value.has(index)
}

function photoLoading(index: number): boolean {
  return requested(index) && !loaded(index) && !failed(index)
}

function markLoaded(index: number): void {
  loadedIndexes.value = replaceSet(loadedIndexes.value, (next) => next.add(index))
}

function markFailed(index: number): void {
  failedIndexes.value = replaceSet(failedIndexes.value, (next) => next.add(index))
}

function slideIndex(swiper: SwiperLike): number {
  const index = typeof swiper.realIndex === 'number' ? swiper.realIndex : swiper.activeIndex
  return typeof index === 'number' && Number.isFinite(index) ? index : 0
}

function requestActivePhoto(swiper: SwiperLike): void {
  requestPhoto(slideIndex(swiper))
}

watch(() => props.photos.join('\n'), () => {
  requestedIndexes.value = new Set([0])
  loadedIndexes.value = new Set()
  failedIndexes.value = new Set()
})
</script>

<template>
  <Swiper
    :modules="swiperModules"
    :navigation="photos.length > 1"
    :pagination="photos.length > 1 ? { type: 'fraction' } : false"
    :threshold="8"
    :watch-slides-progress="true"
    class="auction-card-swiper aspect-16/10"
    @swiper="requestActivePhoto"
    @slide-change="requestActivePhoto"
    @active-index-change="requestActivePhoto"
  >
    <SwiperSlide v-for="(url, index) in photos" :key="`${index}:${url}`" class="relative bg-muted">
      <img
        v-if="requested(index) && !failed(index)"
        :src="url"
        :loading="index === 0 ? 'lazy' : 'eager'"
        :alt="t('objektDetail.photoAlt', { n: index + 1, total: photos.length, title: altBase })"
        referrerpolicy="no-referrer"
        class="h-full w-full object-cover"
        @load="markLoaded(index)"
        @error="markFailed(index)"
      >
      <div v-if="!requested(index)" class="h-full w-full bg-muted" aria-hidden="true" />
      <div v-else-if="failed(index)" class="flex h-full w-full items-center justify-center bg-muted text-muted-foreground text-sm">
        {{ t('search.noPhoto') }}
      </div>
      <div
        v-else-if="photoLoading(index)"
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-muted/40"
        aria-hidden="true"
      >
        <span class="photo-loading-spinner" />
      </div>
    </SwiperSlide>
  </Swiper>
</template>

<style scoped>
.auction-card-swiper {
  width: 100%;
  background: var(--muted);
}

.auction-card-swiper :deep(.swiper-button-prev),
.auction-card-swiper :deep(.swiper-button-next) {
  width: 2rem;
  height: 2rem;
  margin-top: -1rem;
  border-radius: 9999px;
  background: rgb(0 0 0 / 55%);
  color: white;
  opacity: 0.9;
  transition: opacity 150ms ease;
}

:global(.group:hover) .auction-card-swiper :deep(.swiper-button-prev),
:global(.group:hover) .auction-card-swiper :deep(.swiper-button-next),
.auction-card-swiper :deep(.swiper-button-prev:focus-visible),
.auction-card-swiper :deep(.swiper-button-next:focus-visible) {
  opacity: 1;
}

.auction-card-swiper :deep(.swiper-button-prev.swiper-button-disabled),
.auction-card-swiper :deep(.swiper-button-next.swiper-button-disabled) {
  opacity: 0.25;
}

.auction-card-swiper :deep(.swiper-button-prev::after),
.auction-card-swiper :deep(.swiper-button-next::after) {
  font-size: 0.75rem;
  font-weight: 700;
}

.auction-card-swiper :deep(.swiper-pagination-fraction) {
  right: 0.5rem;
  bottom: 0.5rem;
  left: auto;
  width: auto;
  border-radius: 9999px;
  background: rgb(0 0 0 / 65%);
  padding: 0.125rem 0.5rem;
  color: white;
  font-size: 0.75rem;
}

.photo-loading-spinner {
  width: 2rem;
  height: 2rem;
  border: 0.25rem solid rgb(255 255 255 / 75%);
  border-top-color: rgb(59 130 246);
  border-radius: 9999px;
  animation: photo-loading-spin 900ms linear infinite;
}

@keyframes photo-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (hover: none) {
  .auction-card-swiper :deep(.swiper-button-prev),
  .auction-card-swiper :deep(.swiper-button-next) {
    opacity: 0.8;
  }
}
</style>
