<script setup lang="ts">
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Navigation, Pagination, Keyboard } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import type { Attachment } from '~/types/auction'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { apiErrorMessage } from '~/lib/api-error'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'

const props = defineProps<{
  auction: GeoAuction
  /** Viewer's target content language, or null when it isn't one of the
   *  supported translation targets. */
  lang: ContentTargetLang | null
}>()

const { t } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay } = useCurrencyDisplay()

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

const detail = ref<AuctionDetail | null>(null)
const photos = ref<Attachment[]>([])
const thumbnailUrl = ref<string | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const translatedTitle = ref<string | null>(null)
const displayTitle = computed(() => translatedTitle.value ?? detail.value?.title ?? null)

interface AuctionTranslationResponse {
  title: string | null
}

// Loaded silently alongside the detail fetch, same as the objekt detail page
// (pages/objekt/[platform]/[id].vue) — the address stays untranslated
// everywhere in the app (it's a place name), only the title needs this.
async function loadTranslation(): Promise<void> {
  if (!props.lang || isPassthroughLanguage(props.auction.country, props.lang)) return
  try {
    const value = await $fetch<AuctionTranslationResponse>(
      `/api/auction/${encodeURIComponent(props.auction.platform)}/${encodeURIComponent(props.auction.externalId)}/translation`,
      { method: 'POST', query: { lang: props.lang } },
    )
    translatedTitle.value = value.title
  } catch {
    // Silent fallback to the original title — the compact popover has no
    // room for a dedicated translation-error state.
  }
}

onMounted(async () => {
  loadTranslation()
  try {
    const value = await $fetch<AuctionDetail>(
      `/api/auction/${encodeURIComponent(props.auction.platform)}/${encodeURIComponent(props.auction.externalId)}`,
    )
    detail.value = value
    photos.value = extractPhotos(value.attachments)
    thumbnailUrl.value = value.thumbnailUrl
  } catch (err) {
    loadError.value = apiErrorMessage(err, 'Objektdetails konnten nicht geladen werden.')
  } finally {
    loading.value = false
  }
})

function formatPrice(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString(intlLocale.value, {
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
            <img :src="slideSrc(p)" referrerpolicy="no-referrer" loading="lazy" :alt="t('lotPopover.photoAlt', { n: i + 1, title: displayTitle ?? t('lotPopover.untitled') })">
          </a>
        </SwiperSlide>
      </Swiper>
    </div>
    <div v-else-if="loading" class="lot-popover__placeholder">{{ t('lotPopover.loadingPhotos') }}</div>
    <p v-else-if="loadError" class="lot-popover__error">{{ loadError }}</p>
    <div v-else-if="thumbnailUrl" class="lot-popover__media">
      <img :src="thumbnailUrl" referrerpolicy="no-referrer" class="lot-popover__thumb">
    </div>

    <div class="lot-popover__title">{{ displayTitle ?? t('lotPopover.untitled') }}</div>
    <div class="lot-popover__address">{{ detail?.address ?? '' }}</div>

    <div class="lot-popover__grid">
      <div>
        <div class="lot-popover__grid-label">{{ t('lotPopover.auctionDate') }}</div>
        {{ formatDate(detail?.auctionDateIso ?? null, detail?.auctionDateText ?? null) }}
      </div>
      <div>
        <div class="lot-popover__grid-label">{{ t('lotPopover.marketValue') }}</div>
        {{ detail ? (eurToDisplay(detail.marketValueEur) != null ? formatPrice(eurToDisplay(detail.marketValueEur)) : (detail.marketValueText ?? '–')) : '–' }}
      </div>
    </div>

    <div class="lot-popover__cta">
      <a :href="`/objekt/${encodeURIComponent(auction.platform)}/${encodeURIComponent(auction.externalId)}`">
        {{ t('lotPopover.viewDetails') }}
      </a>
    </div>

    <div class="lot-popover__footer">
      <span v-if="detail" class="lot-popover__source">{{ detail.authority }} · {{ detail.caseNumber }}</span><br>
      <a v-if="detail?.pdfUrl" :href="detail.pdfUrl" target="_blank" rel="noopener">{{ t('lotPopover.announcement') }}</a>
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
.lot-popover__error {
  color: #b91c1c;
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
