<script setup lang="ts">
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Navigation, Pagination, Keyboard } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import type { AuctionSummary } from '~/server/api/auctions.get'
import { apiErrorMessage } from '~/lib/api-error'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { fetchWithPendingRetry } from '~/lib/pending-retry'

const props = defineProps<{
  auction: GeoAuction
  /** Already-loaded summary for this auction, when the search grid has it in
   *  its currently-loaded page — skips the fallback fetch below entirely. */
  summary: AuctionSummary | null
  /** Viewer's target content language, or null when it isn't one of the
   *  supported translation targets. */
  lang: ContentTargetLang | null
}>()

const { t } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay } = useCurrencyDisplay()

const fetchedSummary = ref<AuctionSummary | null>(null)
const detail = computed<AuctionSummary | null>(() => props.summary ?? fetchedSummary.value)
const photos = computed<string[]>(() => detail.value?.galleryUrls ?? [])
const loading = ref(!props.summary)
const loadError = ref<string | null>(null)
const translatedTitle = ref<string | null>(null)
const translatedAddress = ref<string | null>(null)
const displayTitle = computed(() => translatedTitle.value ?? detail.value?.title ?? null)
const displayAddress = computed(() => translatedAddress.value ?? detail.value?.address ?? null)
let isActive = true

interface AuctionTranslationResponse {
  title: string | null
  address: string | null
}

const TRANSLATION_PENDING_RETRY_MS = 2500
const TRANSLATION_PENDING_MAX_POLLS = 24

// Loaded silently alongside the summary lookup below, same as the objekt
// detail page (pages/objekt/[platform]/[id].vue).
async function loadTranslation(): Promise<void> {
  if (!props.lang || isPassthroughLanguage(props.auction.country, props.lang)) return
  try {
    const value = await fetchWithPendingRetry(
      () => $fetch<AuctionTranslationResponse>(
        `/api/auction/${encodeURIComponent(props.auction.platform)}/${encodeURIComponent(props.auction.externalId)}/translation`,
        { method: 'POST', query: { lang: props.lang } },
      ),
      {
        maxPolls: TRANSLATION_PENDING_MAX_POLLS,
        retryMs: TRANSLATION_PENDING_RETRY_MS,
        shouldContinue: () => isActive,
      },
    )
    if (value && isActive) {
      translatedTitle.value = value.title
      translatedAddress.value = value.address
    }
  } catch {
    // Silent fallback to the original title/address — the compact popover has
    // no room for a dedicated translation-error state.
  }
}

onUnmounted(() => {
  isActive = false
})

onMounted(async () => {
  loadTranslation()
  if (props.summary) return
  loading.value = true
  try {
    fetchedSummary.value = await $fetch<AuctionSummary>(
      `/api/auction/${encodeURIComponent(props.auction.platform)}/${encodeURIComponent(props.auction.externalId)}/summary`,
    )
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
  <div class="min-w-[260px] font-sans text-[13px] leading-[1.45]">
    <div v-if="photos.length > 0" class="mb-2">
      <Swiper
        :modules="swiperModules"
        :navigation="photos.length > 1"
        :pagination="photos.length > 1 ? { clickable: true } : false"
        :keyboard="{ enabled: true }"
        :loop="photos.length > 1"
        class="lot-popover__swiper h-40 w-full overflow-hidden rounded-md bg-gray-100"
      >
        <SwiperSlide v-for="(url, i) in photos" :key="url">
          <a :href="url" target="_blank" rel="noopener">
            <img
              :src="url"
              referrerpolicy="no-referrer"
              :loading="i === 0 ? 'eager' : 'lazy'"
              :fetchpriority="i === 0 ? 'high' : 'auto'"
              :alt="t('lotPopover.photoAlt', { n: i + 1, title: displayTitle ?? t('lotPopover.untitled') })"
            >
          </a>
        </SwiperSlide>
      </Swiper>
    </div>
    <div v-else-if="loading" class="mb-2 flex h-40 items-center justify-center rounded-md bg-gray-100 text-gray-500">{{ t('lotPopover.loadingPhotos') }}</div>
    <p v-else-if="loadError" class="mb-2 text-red-700">{{ loadError }}</p>

    <div class="mb-0.5 text-sm font-semibold">{{ displayTitle ?? t('lotPopover.untitled') }}</div>
    <div class="mb-[0.4rem] text-gray-500">{{ displayAddress ?? '' }}</div>

    <div class="mb-[0.4rem] grid grid-cols-2 gap-[0.4rem] text-xs">
      <div>
        <div class="text-[10px] uppercase text-gray-500">{{ t('lotPopover.auctionDate') }}</div>
        {{ formatDate(detail?.auctionDateIso ?? null, detail?.auctionDateText ?? null) }}
      </div>
      <div>
        <div class="text-[10px] uppercase text-gray-500">{{ t('lotPopover.marketValue') }}</div>
        {{ detail ? (eurToDisplay(detail.marketValueEur) != null ? formatPrice(eurToDisplay(detail.marketValueEur)) : (detail.marketValueText ?? '–')) : '–' }}
      </div>
    </div>

    <div class="mb-2">
      <a
        :href="`/objekt/${encodeURIComponent(auction.platform)}/${encodeURIComponent(auction.externalId)}`"
        class="block rounded-md bg-amber-500 px-[0.6rem] py-[0.4rem] text-center font-semibold text-white no-underline hover:bg-amber-600"
      >
        {{ t('lotPopover.viewDetails') }}
      </a>
    </div>

    <div class="border-t border-gray-200 pt-[0.4rem] text-xs">
      <span v-if="detail" class="text-gray-500">{{ detail.authority }} · {{ detail.caseNumber }}</span><br>
      <a v-if="detail?.pdfUrl" :href="detail.pdfUrl" target="_blank" rel="noopener">{{ t('lotPopover.announcement') }}</a>
    </div>
  </div>
</template>

<style scoped>
.lot-popover__swiper :deep(.swiper-slide) img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.lot-popover__swiper :deep(.swiper-slide) a {
  display: block;
  height: 100%;
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
  background: rgb(245 158 11);
}
</style>
