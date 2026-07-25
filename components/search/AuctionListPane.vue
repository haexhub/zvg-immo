<script setup lang="ts">
import { Star } from 'lucide-vue-next'
import { Navigation, Pagination } from 'swiper/modules'
import { Swiper, SwiperSlide } from 'swiper/vue'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import { auctionPhotoUrls } from '~/lib/auction-photos'
import type { Auction } from '~/types/auction'

const props = defineProps<{
  auctions: Auction[]
  totalCount: number
  pending: boolean
  loggedIn: boolean
  watchlistIds: Map<string, string>
}>()

const emit = defineEmits<{
  (e: 'toggle-watchlist', auction: Auction): void
  (e: 'load-more'): void
}>()

const intlLocale = useIntlLocale()
const { currency, eurToDisplay, nativeToDisplay } = useCurrencyDisplay()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()
const swiperModules = [Navigation, Pagination]

const photosByAuction = computed(() => {
  const photos = new Map<string, string[]>()
  for (const auction of props.auctions) {
    photos.set(watchlistKey(auction), auctionPhotoUrls(auction))
  }
  return photos
})

function cardPhotos(a: Auction): string[] {
  return photosByAuction.value.get(watchlistKey(a)) ?? []
}

function watchlistKey(a: Auction): string {
  return `${a.platform}:${a.externalId}`
}

function detailPath(a: Auction): string {
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
function originalPriceText(a: Auction): string | null {
  return a.marketValueText ?? null
}
function showOriginalPrice(a: Auction): boolean {
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
function bidLine(a: Auction): string | null {
  const amount = a.currentBid ?? a.startingBid
  if (amount == null) return null
  const converted = nativeToDisplay(amount, a.currency)
  if (converted == null) return null
  return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}
</script>

<template>
  <div class="h-full overflow-y-auto pb-4">
    <p v-if="props.auctions.length === 0 && props.totalCount === 0 && !props.pending" class="py-12 text-center text-muted-foreground">
      {{ $t('search.noResults') }}
    </p>

    <ul v-if="props.auctions.length" class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
      <li v-for="a in props.auctions" :key="`${a.platform}:${a.externalId}`">
        <article
          class="group h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden transition-shadow hover:shadow-md"
          :class="{ 'opacity-60': a.cancelled }"
        >
          <div class="relative border-b">
            <Swiper
              v-if="cardPhotos(a).length"
              :modules="swiperModules"
              :navigation="cardPhotos(a).length > 1"
              :pagination="cardPhotos(a).length > 1 ? { type: 'fraction' } : false"
              :threshold="8"
              :watch-slides-progress="true"
              class="auction-card-swiper aspect-16/10"
            >
              <SwiperSlide v-for="(url, index) in cardPhotos(a)" :key="url">
                <img
                  :src="url"
                  loading="lazy"
                  :alt="$t('objektDetail.photoAlt', { n: index + 1, total: cardPhotos(a).length, title: a.title || a.address || $t('search.unknownPropertyType') })"
                  referrerpolicy="no-referrer"
                  class="h-full w-full object-cover"
                >
                <div class="swiper-lazy-preloader" />
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
              :class="{ 'text-amber-500': props.watchlistIds.has(watchlistKey(a)) }"
              :title="props.watchlistIds.has(watchlistKey(a)) ? $t('search.removeFromWatchlist') : $t('search.addToWatchlist')"
              @click="emit('toggle-watchlist', a)"
            >
              <Star class="h-4 w-4" :class="{ 'fill-current': props.watchlistIds.has(watchlistKey(a)) }" />
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
  opacity: 0;
  transition: opacity 150ms ease;
}

.group:hover .auction-card-swiper :deep(.swiper-button-prev),
.group:hover .auction-card-swiper :deep(.swiper-button-next),
.auction-card-swiper :deep(.swiper-button-prev:focus-visible),
.auction-card-swiper :deep(.swiper-button-next:focus-visible) {
  opacity: 1;
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

@media (hover: none) {
  .auction-card-swiper :deep(.swiper-button-prev),
  .auction-card-swiper :deep(.swiper-button-next) {
    display: none;
  }
}
</style>
