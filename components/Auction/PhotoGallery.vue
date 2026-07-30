<script setup lang="ts">
// Photo slideshow + lightbox for the auction detail page: an inline Swiper
// carousel, any slide of which opens a larger fullscreen Swiper carousel.
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

const lightboxOpen = ref(false)
const activeIndex = ref(0)

function openLightbox(index: number) {
  activeIndex.value = index
  lightboxOpen.value = true
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && lightboxOpen.value) {
    lightboxOpen.value = false
  }
}

watch(lightboxOpen, (open) => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open ? 'hidden' : ''
  if (open) {
    document.addEventListener('keydown', handleKeydown)
  } else {
    document.removeEventListener('keydown', handleKeydown)
  }
})

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.body.style.overflow = ''
    document.removeEventListener('keydown', handleKeydown)
  }
})

const swiperModules = [Navigation, Pagination, Keyboard]
</script>

<template>
  <section v-if="photos.length" class="mb-8">
    <Swiper
      :modules="swiperModules"
      :navigation="photos.length > 1"
      :pagination="photos.length > 1 ? { type: 'fraction' } : false"
      :keyboard="{ enabled: true }"
      :loop="photos.length > 1"
      class="auction-gallery-swiper rounded-xl bg-muted"
    >
      <SwiperSlide v-for="(url, i) in photos" :key="url">
        <button
          type="button"
          class="block h-full w-full"
          :aria-label="t('objektDetail.showPhoto', { n: i + 1 })"
          @click="openLightbox(i)"
        >
          <img
            :src="url"
            :alt="t('objektDetail.photoAlt', { n: i + 1, total: photos.length, title: altBase })"
            referrerpolicy="no-referrer"
            :loading="i === 0 ? 'eager' : 'lazy'"
            class="h-full w-full object-cover"
          >
        </button>
      </SwiperSlide>
    </Swiper>

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
        >
          <SwiperSlide v-for="(url, i) in photos" :key="url" class="flex items-center justify-center">
            <img
              :src="url"
              :alt="t('objektDetail.photoAlt', { n: i + 1, total: photos.length, title: altBase })"
              referrerpolicy="no-referrer"
              loading="lazy"
              class="max-h-[85vh] max-w-full object-contain"
            >
          </SwiperSlide>
        </Swiper>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.auction-gallery-swiper {
  width: 100%;
  height: 16rem;
}
@media (min-width: 640px) {
  .auction-gallery-swiper {
    height: 24rem;
  }
}
.auction-gallery-swiper :deep(.swiper-button-prev),
.auction-gallery-swiper :deep(.swiper-button-next) {
  color: #fff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
.auction-gallery-swiper :deep(.swiper-pagination-fraction) {
  bottom: 0.75rem;
  width: auto;
  right: 0.75rem;
  left: auto;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 0.25rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
}

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
