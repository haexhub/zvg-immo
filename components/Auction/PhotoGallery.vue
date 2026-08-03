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
const lightboxRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
let triggerElement: HTMLElement | null = null
let previousBodyOverflow: string | null = null

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

function openLightbox(index: number, event: MouseEvent) {
  // Not document.activeElement — a click doesn't reliably focus its target
  // first, so that can point at whatever was focused before instead of the
  // slide the user actually clicked.
  triggerElement = event.currentTarget as HTMLElement
  activeIndex.value = index
  lightboxOpen.value = true
}

function trapFocus(e: KeyboardEvent) {
  const container = lightboxRef.value
  if (!container) return
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
  if (!focusable.length) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (!lightboxOpen.value) return
  if (e.key === 'Escape') {
    lightboxOpen.value = false
  } else if (e.key === 'Tab') {
    trapFocus(e)
  }
}

watch(lightboxOpen, async (open) => {
  if (typeof document === 'undefined') return
  if (open) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeydown)
    await nextTick()
    closeButtonRef.value?.focus()
  } else {
    document.body.style.overflow = previousBodyOverflow ?? ''
    previousBodyOverflow = null
    document.removeEventListener('keydown', handleKeydown)
    triggerElement?.focus()
    triggerElement = null
  }
})

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    if (previousBodyOverflow !== null) document.body.style.overflow = previousBodyOverflow
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
      class="auction-gallery-swiper h-64 w-full rounded-xl bg-muted sm:h-96"
    >
      <SwiperSlide v-for="(url, i) in photos" :key="url">
        <button
          type="button"
          class="block h-full w-full"
          :aria-label="t('objektDetail.showPhoto', { n: i + 1 })"
          @click="openLightbox(i, $event)"
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
        ref="lightboxRef"
        role="dialog"
        aria-modal="true"
        :aria-label="altBase"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
        @click.self="lightboxOpen = false"
      >
        <button
          ref="closeButtonRef"
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
          class="auction-gallery-lightbox w-full max-w-[1100px]"
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

.auction-gallery-lightbox :deep(.swiper-button-prev),
.auction-gallery-lightbox :deep(.swiper-button-next) {
  color: #fff;
}
.auction-gallery-lightbox :deep(.swiper-pagination-bullet) {
  background: rgba(255, 255, 255, 0.85);
  opacity: 1;
}
</style>
