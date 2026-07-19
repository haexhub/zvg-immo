<script setup lang="ts">
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Navigation, Pagination, Keyboard } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import type { Attachment } from '~/types/auction'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import type { AuctionPhotoDetail } from '~/server/api/auction-detail.get'

// Mounted into its own detached Vue app by AuctionMap.client.vue's Leaflet
// popup (see mountLotPopover() there) — that app never installs the Nuxt i18n
// plugin, so useI18n() would throw here. The parent (a real part of the Nuxt
// tree) passes its own `t`/`intlLocale` down as plain props instead.
const props = defineProps<{
  auction: GeoAuction
  t: (key: string, params?: Record<string, unknown>) => string
  intlLocale: string
  /** Viewer's display currency (WP-7) — pre-resolved by the parent since this
   *  detached app has no Nuxt context to call useCurrencyDisplay() itself. */
  currency: string
  /** auction.marketValueEur already converted to `currency` by the parent. */
  convertedMarketValue: number | null
}>()

const LAZY_PLATFORMS = new Set(['at-edikte', 'biddit', 'zvg-portal'])

function extractPhotos(atts: Attachment[]): Attachment[] {
  return atts.filter((a) => a.kind === 'photo')
}

// AT-Edikte and zvg-portal publish "Foto" attachments as PDFs (one photo per
// page). `<img src="…pdf">` fails silently in the browser, so we route those
// through /api/pdf-thumb which rasterises the first page.
function slideSrc(a: Attachment): string {
  if (/\.pdf(?:[?#]|$)/i.test(a.proxyUrl)) {
    return `/api/pdf-thumb?src=${encodeURIComponent(a.proxyUrl)}`
  }
  return a.proxyUrl
}

const photos = ref<Attachment[]>(extractPhotos(props.auction.attachments))
const thumbnailUrl = ref<string | null>(props.auction.thumbnailUrl)
const loading = ref(false)

onMounted(async () => {
  if (photos.value.length > 0) return
  if (!LAZY_PLATFORMS.has(props.auction.platform)) return
  loading.value = true
  try {
    const detail = await $fetch<AuctionPhotoDetail>('/api/auction-detail', {
      query: {
        platform: props.auction.platform,
        externalId: props.auction.externalId,
        region: props.auction.region,
      },
    })
    photos.value = extractPhotos(detail.attachments)
    if (detail.thumbnailUrl) thumbnailUrl.value = detail.thumbnailUrl
  } catch {
    // Silent; user can still open the detail link.
  } finally {
    loading.value = false
  }
})

function formatPrice(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString(props.intlLocale, { style: 'currency', currency: props.currency, maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString(props.intlLocale, {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

const swiperModules = [Navigation, Pagination, Keyboard]
</script>

<template>
  <div class="lot-popover">
    <div v-if="photos.length > 0" class="lot-popover__media">
      <Swiper
        :modules="swiperModules"
        :navigation="photos.length > 1"
        :pagination="photos.length > 1 ? { clickable: true } : false"
        :keyboard="{ enabled: true }"
        :loop="photos.length > 1"
        class="lot-popover__swiper"
      >
        <SwiperSlide v-for="(p, i) in photos" :key="p.fileId || i">
          <a :href="p.proxyUrl" target="_blank" rel="noopener">
            <img :src="slideSrc(p)" referrerpolicy="no-referrer" loading="lazy" :alt="t('lotPopover.photoAlt', { n: i + 1, title: auction.title ?? t('lotPopover.untitled') })">
          </a>
        </SwiperSlide>
      </Swiper>
    </div>
    <div v-else-if="loading" class="lot-popover__placeholder">{{ t('lotPopover.loadingPhotos') }}</div>
    <div v-else-if="thumbnailUrl" class="lot-popover__media">
      <a :href="auction.detailUrl ?? undefined" target="_blank" rel="noopener">
        <img :src="thumbnailUrl" referrerpolicy="no-referrer" class="lot-popover__thumb">
      </a>
    </div>

    <div class="lot-popover__title">{{ auction.title ?? t('lotPopover.untitled') }}</div>
    <div class="lot-popover__address">{{ auction.address ?? '' }}</div>

    <div class="lot-popover__grid">
      <div>
        <div class="lot-popover__grid-label">{{ t('lotPopover.auctionDate') }}</div>
        {{ formatDate(auction.auctionDateIso, auction.auctionDateText) }}
      </div>
      <div>
        <div class="lot-popover__grid-label">{{ t('lotPopover.marketValue') }}</div>
        {{ props.convertedMarketValue != null ? formatPrice(props.convertedMarketValue) : (auction.marketValueText ?? '–') }}
      </div>
    </div>

    <div class="lot-popover__cta">
      <a
        v-if="auction.detailAvailable"
        :href="`/objekt/${encodeURIComponent(auction.platform)}/${encodeURIComponent(auction.externalId)}`"
      >{{ t('lotPopover.viewDetails') }}</a>
      <span v-else class="lot-popover__cta-disabled" :title="t('lotPopover.detailsProcessing')">{{ t('lotPopover.detailsUnavailable') }}</span>
    </div>

    <div class="lot-popover__footer">
      <span class="lot-popover__source">{{ auction.authority }} · {{ auction.caseNumber }}</span><br>
      <a v-if="auction.pdfUrl" :href="auction.pdfUrl" target="_blank" rel="noopener">{{ t('lotPopover.announcement') }}</a>
      <span v-if="auction.pdfUrl && auction.detailUrl"> · </span>
      <a v-if="auction.detailUrl" :href="auction.detailUrl" target="_blank" rel="noopener">{{ t('lotPopover.source') }}</a>
    </div>
  </div>
</template>

<style scoped>
.lot-popover {
  min-width: 260px;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
}
.lot-popover__media {
  margin-bottom: 0.5rem;
}
.lot-popover__swiper {
  width: 100%;
  height: 160px;
  border-radius: 6px;
  overflow: hidden;
  background: #f3f4f6;
}
.lot-popover__swiper :deep(.swiper-slide) img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.lot-popover__swiper :deep(.swiper-button-prev),
.lot-popover__swiper :deep(.swiper-button-next) {
  color: #ffffff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
.lot-popover__swiper :deep(.swiper-button-prev)::after,
.lot-popover__swiper :deep(.swiper-button-next)::after {
  font-size: 20px;
  font-weight: 700;
}
.lot-popover__swiper :deep(.swiper-pagination-bullet) {
  background: rgba(255, 255, 255, 0.85);
  opacity: 1;
}
.lot-popover__swiper :deep(.swiper-pagination-bullet-active) {
  background: #2563eb;
}
.lot-popover__thumb {
  width: 100%;
  height: 120px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
}
.lot-popover__placeholder {
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 6px;
  margin-bottom: 0.5rem;
}
.lot-popover__title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 2px;
}
.lot-popover__address {
  color: #6b7280;
  margin-bottom: 0.4rem;
}
.lot-popover__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem;
  font-size: 12px;
  margin-bottom: 0.4rem;
}
.lot-popover__grid-label {
  text-transform: uppercase;
  color: #6b7280;
  font-size: 10px;
}
.lot-popover__cta {
  margin-bottom: 0.5rem;
}
.lot-popover__cta a {
  display: block;
  text-align: center;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  text-decoration: none;
}
.lot-popover__cta a:hover {
  background: #1d4ed8;
}
.lot-popover__cta-disabled {
  display: block;
  text-align: center;
  background: #9ca3af;
  color: #f3f4f6;
  font-weight: 600;
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  cursor: not-allowed;
}
.lot-popover__footer {
  font-size: 12px;
  border-top: 1px solid #e5e7eb;
  padding-top: 0.4rem;
}
.lot-popover__source {
  color: #6b7280;
}
</style>
