<script setup lang="ts">
// Photo grid + lightbox for the auction detail page: a large lead photo next
// to a 2x2 thumbnail grid (collapsing to a single lead photo + scrollable
// strip on narrow screens), any tile of which opens a full Swiper carousel.
// Reuses the Swiper dependency already used by LotPopover.vue for the same
// carousel-with-navigation/pagination/keyboard pattern.
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Keyboard, Navigation, Pagination } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import { X } from 'lucide-vue-next'

const props = defineProps<{
  photos: string[]
  /** Used to build per-photo alt text, e.g. the auction title. */
  altBase: string
}>()

const { t } = useI18n()

const GRID_TILE_COUNT = 4 // thumbnails shown next to the lead photo
const gridTiles = computed(() => props.photos.slice(1, 1 + GRID_TILE_COUNT))
const remainingCount = computed(() => Math.max(0, props.photos.length - 1 - GRID_TILE_COUNT))

const lightboxOpen = ref(false)
const activeIndex = ref(0)
const swiperRef = ref<{ slideToLoop: (i: number) => void } | null>(null)

function openLightbox(index: number) {
  activeIndex.value = index
  lightboxOpen.value = true
}

watch(lightboxOpen, (open) => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open ? 'hidden' : ''
})

onUnmounted(() => {
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})

const swiperModules = [Navigation, Pagination, Keyboard]
</script>

<template>
  <section v-if="photos.length" class="mb-8">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-xl overflow-hidden">
      <button
        type="button"
        class="relative block overflow-hidden bg-muted focus-visible:outline-none"
        :aria-label="t('objektDetail.showPhoto', { n: 1 })"
        @click="openLightbox(0)"
      >
        <img
          :src="photos[0]"
          :alt="t('objektDetail.photoAlt', { n: 1, total: photos.length, title: altBase })"
          referrerpolicy="no-referrer"
          class="h-64 w-full object-cover sm:h-full"
        >
        <span class="absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
          {{ t('objektDetail.gallery.count', { n: photos.length }) }}
        </span>
      </button>

      <div v-if="gridTiles.length" class="grid grid-cols-2 grid-rows-2 gap-2">
        <button
          v-for="(url, i) in gridTiles"
          :key="url"
          type="button"
          class="relative block overflow-hidden bg-muted focus-visible:outline-none"
          :aria-label="t('objektDetail.showPhoto', { n: i + 2 })"
          @click="openLightbox(i + 1)"
        >
          <img
            :src="url"
            :alt="t('objektDetail.photoAlt', { n: i + 2, total: photos.length, title: altBase })"
            referrerpolicy="no-referrer"
            class="h-full w-full min-h-28 object-cover"
          >
          <span
            v-if="i === gridTiles.length - 1 && remainingCount > 0"
            class="absolute inset-0 flex items-center justify-center bg-black/55 text-sm font-semibold text-white"
          >
            {{ t('objektDetail.gallery.more', { n: remainingCount }) }}
          </span>
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="lightboxOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
        @click.self="lightboxOpen = false"
      >
        <button
          type="button"
          class="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          :aria-label="t('objektDetail.gallery.close')"
          @click="lightboxOpen = false"
        >
          <X class="h-5 w-5" />
        </button>
        <Swiper
          :modules="swiperModules"
          :navigation="photos.length > 1"
          :pagination="photos.length > 1 ? { clickable: true } : false"
          :keyboard="{ enabled: true }"
          :loop="photos.length > 1"
          :initial-slide="activeIndex"
          class="auction-gallery-lightbox"
          @swiper="(s) => (swiperRef = s)"
        >
          <SwiperSlide v-for="(url, i) in photos" :key="url" class="flex items-center justify-center">
            <img
              :src="url"
              :alt="t('objektDetail.photoAlt', { n: i + 1, total: photos.length, title: altBase })"
              referrerpolicy="no-referrer"
              class="max-h-[85vh] max-w-full object-contain"
            >
          </SwiperSlide>
        </Swiper>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.auction-gallery-lightbox {
  width: 100%;
  max-width: 1100px;
}
.auction-gallery-lightbox :deep(.swiper-button-prev),
.auction-gallery-lightbox :deep(.swiper-button-next) {
  color: #fff;
}
.auction-gallery-lightbox :deep(.swiper-pagination-bullet) {
  background: rgba(255, 255, 255, 0.85);
  opacity: 1;
}
</style>
