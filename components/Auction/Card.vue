<script setup lang="ts">
import { Star } from 'lucide-vue-next'
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Keyboard, Navigation } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/navigation'
import type { AuctionSummary } from '~/server/api/auctions.get'

const props = withDefaults(defineProps<{
  auction: AuctionSummary
  loggedIn?: boolean
  inWatchlist?: boolean
  active?: boolean
}>(), {
  loggedIn: false,
  inWatchlist: false,
  active: false,
})

const emit = defineEmits<{
  (e: 'toggle-watchlist'): void
}>()

const intlLocale = useIntlLocale()
const { t } = useI18n()
const { currency, eurToDisplay, nativeToDisplay } = useCurrencyDisplay()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()

function cardAltBase(a: AuctionSummary): string {
  return a.title || a.address || t('search.unknownPropertyType')
}

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

const swiperModules = [Navigation, Keyboard]
</script>

<template>
  <article
    class="group h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden transition-all hover:shadow-md"
    :class="{
      'opacity-60': props.auction.cancelled,
      'ring-2 ring-amber-500 border-amber-500 shadow-md': props.active,
    }"
  >
    <div class="relative border-b">
      <Swiper
        v-if="props.auction.galleryUrls.length > 0"
        :modules="swiperModules"
        :navigation="props.auction.galleryUrls.length > 1"
        :keyboard="{ enabled: true }"
        :loop="props.auction.galleryUrls.length > 1"
        :lazy-preload-prev-next="0"
        class="auction-card-swiper aspect-16/10 w-full overflow-hidden bg-muted"
      >
        <SwiperSlide v-for="(url, i) in props.auction.galleryUrls" :key="url">
          <img
            :src="url"
            :alt="t('lotPopover.photoAlt', { n: i + 1, title: cardAltBase(props.auction) })"
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
      <Badge v-if="props.auction.cancelled" variant="destructive" class="absolute z-10 left-2 top-2">{{ $t('search.cancelledBadge') }}</Badge>
      <Badge v-else-if="props.auction.extraction?.condition" variant="secondary" class="absolute z-10 left-2 top-2">{{ conditionLabel(props.auction.extraction.condition) }}</Badge>
      <button
        v-if="props.loggedIn"
        type="button"
        class="absolute z-10 right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 shadow-sm transition-colors hover:bg-background"
        :class="{ 'text-amber-500': props.inWatchlist }"
        :title="props.inWatchlist ? $t('search.removeFromWatchlist') : $t('search.addToWatchlist')"
        @click="emit('toggle-watchlist')"
      >
        <Star class="h-4 w-4" :class="{ 'fill-current': props.inWatchlist }" />
      </button>
    </div>

    <NuxtLink :to="detailPath(props.auction)" class="p-3 flex-1 flex flex-col gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span class="font-mono text-xs text-muted-foreground">{{ props.auction.caseNumber }}</span>
      <p class="text-sm font-medium leading-tight">{{ props.auction.address || props.auction.title || $t('search.unknownPropertyType') }}</p>
      <div v-if="props.auction.extraction?.features?.length" class="flex flex-wrap gap-1">
        <span
          v-for="f in props.auction.extraction.features.slice(0, 3)"
          :key="f"
          class="rounded-md bg-muted/60 text-muted-foreground px-1.5 py-0.5 text-xs"
        >{{ featureLabel(f) }}</span>
      </div>
      <p class="mt-auto pt-1 font-semibold tabular-nums">
        {{ eurToDisplay(props.auction.marketValueEur) != null ? formatPrice(props.auction.marketValueEur) : (props.auction.marketValueText ?? '–') }}
        <span v-if="showOriginalPrice(props.auction)" class="block text-xs font-normal text-muted-foreground">
          {{ $t('search.original', { value: originalPriceText(props.auction) }) }}
        </span>
      </p>
      <p v-if="bidLine(props.auction)" class="text-xs font-normal text-muted-foreground">
        {{ $t(props.auction.currentBid != null ? 'search.currentBid' : 'search.startingBid', { value: bidLine(props.auction) }) }}
      </p>
    </NuxtLink>
  </article>
</template>

<style scoped>
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
</style>
