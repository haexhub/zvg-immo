<script setup lang="ts">
import { Star } from 'lucide-vue-next'
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
            'ring-2 ring-red-500 border-red-500 shadow-md': auctionKey(a) === props.activeAuctionKey,
          }"
        >
          <div class="relative border-b">
            <img
              v-if="a.thumbnailUrl"
              :src="a.thumbnailUrl"
              :alt="cardAltBase(a)"
              class="aspect-16/10 h-full w-full object-cover"
              loading="lazy"
              referrerpolicy="no-referrer"
            >
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
