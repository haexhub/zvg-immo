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

// Photo requests occasionally fail on flaky mobile connections even though
// the file is fine server-side, which previously left a permanently blank
// slide with no way to recover. One cache-busted retry before giving up and
// showing the no-photo placeholder.
const photoRetried = reactive(new Set<string>())
const brokenPhotoUrls = reactive(new Set<string>())

// This component instance is reused across auction detail pages (no :key
// tied to the route, keepalive'd <NuxtPage>) — without this, a photo marked
// broken on one auction would wrongly stay broken forever, even for an
// unrelated later auction or a revisit of the same one.
watch(() => props.photos, () => {
  photoRetried.clear()
  brokenPhotoUrls.clear()
})

function photoIsBroken(url: string): boolean {
  return brokenPhotoUrls.has(url)
}

function photoSrc(url: string): string {
  if (brokenPhotoUrls.has(url)) return '/images/no-photo.svg'
  if (!photoRetried.has(url)) return url
  // Some thumbnail fallbacks (e.g. zvg-portal's /api/zvg-thumb) already carry
  // a query string, so a bare `?retry=` would corrupt their last param; a
  // fragment has to stay at the very end or the server never sees the param.
  const hashIndex = url.indexOf('#')
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex)
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}retry=1${fragment}`
}

function handlePhotoError(url: string, event: Event) {
  // The same url can be on screen twice at once (gallery thumbnail + lightbox
  // slide) and fail independently. Reading what actually failed off the
  // <img> itself, instead of blindly bumping shared retry state, keeps two
  // concurrent failures of the original request idempotent instead of
  // fast-forwarding straight to "broken" without the retry ever happening.
  const failedSrc = (event.target as HTMLImageElement).src
  if (failedSrc.includes('retry=1')) {
    brokenPhotoUrls.add(url)
  } else {
    photoRetried.add(url)
  }
}

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
            :src="photoSrc(url)"
            :alt="t('objektDetail.photoAlt', { n: i + 1, total: photos.length, title: altBase })"
            referrerpolicy="no-referrer"
            :loading="i === 0 ? 'eager' : 'lazy'"
            :class="photoIsBroken(url) ? 'h-full w-full object-contain p-6 opacity-60' : 'h-full w-full object-cover'"
            @error="handlePhotoError(url, $event)"
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
        class="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/90 p-0 sm:p-4"
        @click.self="lightboxOpen = false"
      >
        <!-- z-20: the lightbox Swiper below is `h-full` and Swiper's own
        stylesheet gives `.swiper` `position: relative; z-index: 1`, which
        otherwise wins over this `position: absolute` button (z-index auto)
        and swallows the click on mobile viewports. -->
        <button
          ref="closeButtonRef"
          type="button"
          class="absolute top-4 right-4 z-20 rounded-full bg-black/40 p-2 text-white backdrop-blur-sm hover:bg-black/60"
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
          class="auction-gallery-lightbox h-full w-full max-w-[1100px]"
        >
          <SwiperSlide
            v-for="(url, i) in photos"
            :key="url"
            class="flex items-center justify-center"
            @click.self="lightboxOpen = false"
          >
            <img
              :src="photoSrc(url)"
              :alt="t('objektDetail.photoAlt', { n: i + 1, total: photos.length, title: altBase })"
              referrerpolicy="no-referrer"
              loading="lazy"
              class="max-h-full max-w-full object-contain"
              :class="{ 'opacity-60 p-12': photoIsBroken(url) }"
              @error="handlePhotoError(url, $event)"
            >
          </SwiperSlide>
        </Swiper>
      </div>
    </Teleport>
  </section>
  <img
    v-else
    src="/images/no-photo.svg"
    :alt="t('search.noPhoto')"
    class="mb-8 h-64 w-full rounded-xl bg-muted object-contain p-16 sm:h-96"
  >
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
/* Swiper's own stylesheet sets .swiper-slide { display: block }, which beats
   the slide's `flex items-center justify-center` utility classes on cascade
   order alone — without this, a photo shorter than the lightbox never gets
   vertically centered, it just sticks to the top. */
.auction-gallery-lightbox :deep(.swiper-slide) {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
