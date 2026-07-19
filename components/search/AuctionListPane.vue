<script setup lang="ts">
import { Star } from 'lucide-vue-next'
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
const { currency, eurToDisplay } = useCurrencyDisplay()

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
</script>

<template>
  <div class="h-full overflow-y-auto pb-4">
    <p v-if="props.auctions.length === 0 && props.totalCount === 0 && !props.pending" class="py-12 text-center text-muted-foreground">
      {{ $t('search.noResults') }}
    </p>

    <ul v-if="props.auctions.length" class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
      <li v-for="a in props.auctions" :key="`${a.platform}:${a.externalId}`">
        <NuxtLink
          :to="detailPath(a)"
          class="group h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden transition-shadow hover:shadow-md"
          :class="{ 'opacity-60': a.cancelled }"
        >
          <div class="relative border-b">
            <img
              v-if="a.thumbnailUrl"
              :src="a.thumbnailUrl"
              loading="lazy"
              alt=""
              referrerpolicy="no-referrer"
              class="aspect-16/10 w-full object-cover transition-transform duration-200 group-hover:scale-105"
            >
            <div v-else class="flex aspect-16/10 items-center justify-center bg-muted text-muted-foreground text-sm">
              {{ $t('search.noPhoto') }}
            </div>
            <Badge v-if="a.cancelled" variant="destructive" class="absolute left-2 top-2">{{ $t('search.cancelledBadge') }}</Badge>
            <span
              v-if="a.photoCount > 1"
              class="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white"
            >+{{ a.photoCount - 1 }}</span>
            <button
              v-if="props.loggedIn"
              type="button"
              class="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 shadow-sm transition-colors hover:bg-background"
              :class="{ 'text-amber-500': props.watchlistIds.has(watchlistKey(a)) }"
              :title="props.watchlistIds.has(watchlistKey(a)) ? $t('search.removeFromWatchlist') : $t('search.addToWatchlist')"
              @click.prevent.stop="emit('toggle-watchlist', a)"
            >
              <Star class="h-4 w-4" :class="{ 'fill-current': props.watchlistIds.has(watchlistKey(a)) }" />
            </button>
          </div>

          <div class="p-3 flex-1 flex flex-col gap-1">
            <span class="font-mono text-xs text-muted-foreground">{{ a.caseNumber }}</span>
            <p class="text-sm font-medium leading-tight">{{ a.address || a.title || $t('search.unknownPropertyType') }}</p>
            <p class="mt-auto pt-1 font-semibold tabular-nums">
              {{ eurToDisplay(a.marketValueEur) != null ? formatPrice(a.marketValueEur) : (a.marketValueText ?? '–') }}
              <span v-if="showOriginalPrice(a)" class="block text-xs font-normal text-muted-foreground">
                {{ $t('search.original', { value: originalPriceText(a) }) }}
              </span>
            </p>
          </div>
        </NuxtLink>
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
