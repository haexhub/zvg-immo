<script setup lang="ts">
import { Star } from 'lucide-vue-next'
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Keyboard, Navigation, Pagination } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import { auctionKey } from '~/lib/auction-key'
import type { AuctionSummary } from '~/server/api/auctions.get'

const props = defineProps<{
  auctions: AuctionSummary[]
  totalCount: number
  pending: boolean
  loggedIn: boolean
  watchlistIds: Map<string, string>
  activeAuctionKey?: string | null
  scrollTargetKey?: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle-watchlist', auction: AuctionSummary): void
  (e: 'load-more'): void
  (e: 'auction-hover', key: string | null): void
}>()

const intlLocale = useIntlLocale()
const { t } = useI18n()
const { currency, eurToDisplay, nativeToDisplay } = useCurrencyDisplay()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()

function cardAltBase(a: AuctionSummary): string {
  return a.title || a.address || t('search.unknownPropertyType')
}

function escapeSelectorValue(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

watch(() => props.scrollTargetKey, async (key) => {
  if (!key || !import.meta.client) return
  await nextTick()
  const el = document.querySelector(`[data-auction-key="${escapeSelectorValue(key)}"]`)
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})

function detailPath(a: AuctionSummary): string {
  return `/objekt/${encodeURIComponent(a.platform)}/${encodeURIComponent(a.externalId)}`
}

function formatPrice(marketValueEur: number | null): string {
  const converted = eurToDisplay(marketValueEur)
  if (converted == null) return '–'
  return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}

// Shown alongside the converted figure whenever the auction's native
// currency differs from the viewer's display currency (including a
// EUR-native auction viewed in a non-EUR currency) — see i18n design doc
// Baustein C: "Original + konvertierter Nutzerwert, die Versteigerung läuft
// in der Originalwährung".
function originalPriceText(a: AuctionSummary): string | null {
  return a.marketValueText ?? null
}
function showOriginalPrice(a: AuctionSummary): boolean {
  return originalPriceText(a) != null
    && eurToDisplay(a.marketValueEur) != null
    && (a.currency ?? 'EUR') !== currency.value
}

// Online-bidding-style platforms (Biddit, si, fi, hu, pl, boe, ca,
// us-bid4assets) additionally publish a starting/current bid — German-court-
// style platforms (zvg-portal, at, ...) never set these, so this stays
// null/false there and the card looks exactly as before. Prefer the live
// currentBid over startingBid, matching the price row's own
// marketValueEur-over-marketValueText precedence.
function bidLine(a: AuctionSummary): string | null {
  const amount = a.currentBid ?? a.startingBid
  if (amount == null) return null
  const converted = nativeToDisplay(amount, a.currency)
  if (converted == null) return null
  return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}

const swiperModules = [Navigation, Pagination, Keyboard]
</script>

<template>
  <div class="h-full overflow-y-auto pb-4">
    <p v-if="props.auctions.length === 0 && props.totalCount === 0 && !props.pending" class="py-12 text-center text-muted-foreground">
      {{ $t('search.noResults') }}
    </p>

    <ul v-if="props.auctions.length" class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
      <li
        v-for="a in props.auctions"
        :key="auctionKey(a)"
        :data-auction-key="auctionKey(a)"
        @mouseenter="emit('auction-hover', auctionKey(a))"
        @mouseleave="emit('auction-hover', null)"
        @focusin="emit('auction-hover', auctionKey(a))"
        @focusout="emit('auction-hover', null)"
      >
        <article
          class="group h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden transition-all hover:shadow-md"
          :class="{
            'opacity-60': a.cancelled,
            'ring-2 ring-amber-500 border-amber-500 shadow-md': auctionKey(a) === props.activeAuctionKey,
          }"
        >
          <div class="relative border-b">
            <Swiper
              v-if="a.galleryUrls.length > 0"
              :modules="swiperModules"
              :navigation="a.galleryUrls.length > 1"
              :pagination="a.galleryUrls.length > 1 ? { clickable: true } : false"
              :keyboard="{ enabled: true }"
              :loop="a.galleryUrls.length > 1"
              :lazy-preload-prev-next="0"
              class="auction-card-swiper aspect-16/10 w-full bg-muted"
            >
              <SwiperSlide v-for="(url, i) in a.galleryUrls" :key="url">
                <img
                  :src="url"
                  :alt="t('lotPopover.photoAlt', { n: i + 1, title: cardAltBase(a) })"
                  class="h-full w-full object-cover"
                  referrerpolicy="no-referrer"
                  :loading="i === 0 ? 'eager' : 'lazy'"
                  :fetchpriority="i === 0 ? 'high' : 'auto'"
                >
              </SwiperSlide>
            </Swiper>
            <div v-else class="flex aspect-16/10 items-center justify-center bg-muted text-muted-foreground text-sm">
              {{ $t('search.noPhoto') }}
            </div>
            <Badge v-if="a.cancelled" variant="destructive" class="absolute z-10 left-2 top-2">{{ $t('search.cancelledBadge') }}</Badge>
            <Badge v-else-if="a.extraction?.condition" variant="secondary" class="absolute z-10 left-2 top-2">{{ conditionLabel(a.extraction.condition) }}</Badge>
            <button
              v-if="props.loggedIn"
              type="button"
              class="absolute z-10 right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 shadow-sm transition-colors hover:bg-background"
              :class="{ 'text-amber-500': props.watchlistIds.has(auctionKey(a)) }"
              :title="props.watchlistIds.has(auctionKey(a)) ? $t('search.removeFromWatchlist') : $t('search.addToWatchlist')"
              @click="emit('toggle-watchlist', a)"
            >
              <Star class="h-4 w-4" :class="{ 'fill-current': props.watchlistIds.has(auctionKey(a)) }" />
            </button>
          </div>

          <NuxtLink :to="detailPath(a)" class="p-3 flex-1 flex flex-col gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span class="font-mono text-xs text-muted-foreground">{{ a.caseNumber }}</span>
            <p class="text-sm font-medium leading-tight">{{ a.address || a.title || $t('search.unknownPropertyType') }}</p>
            <div v-if="a.extraction?.features?.length" class="flex flex-wrap gap-1">
              <span
                v-for="f in a.extraction.features.slice(0, 3)"
                :key="f"
                class="rounded-md bg-muted/60 text-muted-foreground px-1.5 py-0.5 text-xs"
              >{{ featureLabel(f) }}</span>
            </div>
            <p class="mt-auto pt-1 font-semibold tabular-nums">
              {{ eurToDisplay(a.marketValueEur) != null ? formatPrice(a.marketValueEur) : (a.marketValueText ?? '–') }}
              <span v-if="showOriginalPrice(a)" class="block text-xs font-normal text-muted-foreground">
                {{ $t('search.original', { value: originalPriceText(a) }) }}
              </span>
            </p>
            <p v-if="bidLine(a)" class="text-xs font-normal text-muted-foreground">
              {{ $t(a.currentBid != null ? 'search.currentBid' : 'search.startingBid', { value: bidLine(a) }) }}
            </p>
          </NuxtLink>
        </article>
      </li>
    </ul>

    <div v-if="props.auctions.length < props.totalCount" class="flex flex-col items-center gap-2 pt-2 pb-4">
      <p class="text-xs text-muted-foreground">{{ $t('search.loadMoreShown', { shown: props.auctions.length, total: props.totalCount }) }}</p>
      <Button type="button" variant="outline" @click="emit('load-more')">
        {{ $t('search.loadMore') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.auction-card-swiper {
  overflow: hidden;
}
.auction-card-swiper :deep(.swiper-button-prev),
.auction-card-swiper :deep(.swiper-button-next) {
  color: #ffffff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
.auction-card-swiper :deep(.swiper-button-prev)::after,
.auction-card-swiper :deep(.swiper-button-next)::after {
  font-size: 1rem;
  font-weight: 700;
}
.auction-card-swiper :deep(.swiper-pagination) {
  bottom: 0.35rem;
}
.auction-card-swiper :deep(.swiper-pagination-bullet) {
  background: rgba(255, 255, 255, 0.85);
  opacity: 1;
}
.auction-card-swiper :deep(.swiper-pagination-bullet-active) {
  background: rgb(245 158 11);
}
</style>
