<script setup lang="ts">
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Navigation, Pagination, Keyboard } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import type { GeoAuction } from '~/server/api/auctions-geo.get'

const props = defineProps<{ auction: GeoAuction }>()

// Photos come from the enrich task's extraction cache (see
// server/utils/extraction-cache.ts): every file lives locally under
// .cache_zvg/images/<platform>/<zvgId>/ and is served by /api/auction-image.
// Falling back to the single thumbnailUrl keeps the popover useful for lots
// whose snapshot hasn't been built yet.
const photoUrls = computed<string[]>(() => {
  const photos = props.auction.extraction?.photos ?? []
  if (photos.length === 0) return props.auction.thumbnailUrl ? [props.auction.thumbnailUrl] : []
  return photos.map((name) =>
    `/api/auction-image/${encodeURIComponent(props.auction.platform)}/${encodeURIComponent(props.auction.zvgId)}/${encodeURIComponent(name)}`,
  )
})

const detailHref = computed(
  () =>
    `/objekt/${encodeURIComponent(props.auction.platform)}/${encodeURIComponent(props.auction.zvgId)}`,
)

function formatEur(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

const swiperModules = [Navigation, Pagination, Keyboard]
</script>

<template>
  <div class="lot-popover">
    <div v-if="photoUrls.length > 0" class="lot-popover__media">
      <Swiper
        :modules="swiperModules"
        :navigation="photoUrls.length > 1"
        :pagination="photoUrls.length > 1 ? { clickable: true } : false"
        :keyboard="{ enabled: true }"
        :loop="photoUrls.length > 1"
        class="lot-popover__swiper"
      >
        <SwiperSlide v-for="(url, i) in photoUrls" :key="i">
          <a :href="detailHref">
            <img :src="url" referrerpolicy="no-referrer" loading="lazy" :alt="`Foto ${i + 1} – ${auction.objekt ?? 'Objekt'}`">
          </a>
        </SwiperSlide>
      </Swiper>
    </div>

    <div class="lot-popover__title">
      <a :href="detailHref">{{ auction.objekt ?? 'Objekt' }}</a>
    </div>
    <div class="lot-popover__address">{{ auction.adresse ?? '' }}</div>

    <div class="lot-popover__grid">
      <div>
        <div class="lot-popover__grid-label">Termin</div>
        {{ formatDate(auction.terminIso, auction.terminText) }}
      </div>
      <div>
        <div class="lot-popover__grid-label">Verkehrswert</div>
        {{ formatEur(auction.verkehrswertEur) }}
      </div>
    </div>

    <div class="lot-popover__footer">
      <span class="lot-popover__source">{{ auction.amtsgericht }} · {{ auction.aktenzeichen }}</span><br>
      <a v-if="auction.pdfUrl" :href="auction.pdfUrl" target="_blank" rel="noopener">Bekanntmachung</a>
      <span v-if="auction.pdfUrl"> · </span>
      <a :href="detailHref">Details</a>
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
.lot-popover__title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 2px;
}
.lot-popover__title a {
  color: inherit;
  text-decoration: none;
}
.lot-popover__title a:hover {
  text-decoration: underline;
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
.lot-popover__footer {
  font-size: 12px;
  border-top: 1px solid #e5e7eb;
  padding-top: 0.4rem;
}
.lot-popover__source {
  color: #6b7280;
}
</style>
