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

const { t, locale } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay } = useCurrencyDisplay()
const attachmentKindLabelFn = useAttachmentKindLabel()
void locale

function watchlistKey(a: Auction): string {
  return `${a.platform}:${a.externalId}`
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

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString(intlLocale.value, {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

function attachmentLabel(att: { kind: string; label: string }): string {
  return attachmentKindLabelFn(att.kind, att.label || t('attachmentKind.other'))
}
</script>

<template>
  <div class="h-full overflow-y-auto pb-4">
    <p v-if="props.auctions.length === 0 && props.totalCount === 0 && !props.pending" class="py-12 text-center text-muted-foreground">
      {{ $t('search.noResults') }}
    </p>

    <ul v-if="props.auctions.length" class="grid gap-4 grid-cols-1">
      <li v-for="a in props.auctions" :key="`${a.platform}:${a.externalId}`">
        <article
          class="h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden"
          :class="{ 'opacity-60': a.cancelled }"
        >
          <a
            v-if="a.thumbnailUrl"
            :href="a.attachments.find((x) => x.kind === 'photo')?.proxyUrl ?? a.detailUrl ?? undefined"
            target="_blank"
            rel="noopener"
            class="relative block overflow-hidden border-b group"
            :title="$t('search.openPhotos', { count: a.photoCount, plural: a.photoCount === 1 ? '' : 's' })"
          >
            <img
              :src="a.thumbnailUrl"
              loading="lazy"
              alt=""
              referrerpolicy="no-referrer"
              class="aspect-16/10 w-full object-cover transition-transform duration-200 group-hover:scale-105"
            >
            <span
              v-if="a.photoCount > 1"
              class="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white"
            >+{{ a.photoCount - 1 }}</span>
          </a>
          <div v-else-if="!a.cancelled" class="flex aspect-16/10 items-center justify-center bg-muted text-muted-foreground text-sm border-b">
            {{ $t('search.noPhoto') }}
          </div>

          <div class="p-4 flex-1 flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">{{ a.authority }}</Badge>
              <Badge v-if="a.region" variant="outline">{{ a.region }}</Badge>
              <Badge v-if="a.cancelled" variant="destructive">{{ $t('search.cancelledBadge') }}</Badge>
              <span class="font-mono text-muted-foreground">{{ a.caseNumber }}</span>
            </div>
            <h2 class="text-base font-semibold leading-tight mt-1">{{ a.title || $t('search.unknownPropertyType') }}</h2>
            <p v-if="a.address" class="text-sm text-muted-foreground">{{ a.address }}</p>
            <p v-if="a.description" class="text-sm text-muted-foreground leading-relaxed mt-1">
              {{ truncate(a.description, 220) }}
            </p>
            <dl class="grid grid-cols-2 gap-3 text-sm mt-2">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('search.auctionDate') }}</dt>
                <dd class="font-medium">{{ formatDate(a.auctionDateIso, a.auctionDateText) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('search.marketValue') }}</dt>
                <dd class="font-medium tabular-nums">
                  {{ eurToDisplay(a.marketValueEur) != null ? formatPrice(a.marketValueEur) : (a.marketValueText ?? '–') }}
                  <span v-if="showOriginalPrice(a)" class="block text-xs font-normal text-muted-foreground">
                    {{ $t('search.original', { value: originalPriceText(a) }) }}
                  </span>
                </dd>
              </div>
            </dl>
          </div>

          <footer class="border-t px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <a v-if="a.pdfUrl" :href="a.pdfUrl" target="_blank" rel="noopener" class="text-primary hover:underline">
              {{ $t('attachmentKind.announcement') }}
            </a>
            <a
              v-for="att in a.attachments.filter((x) => x.kind !== 'announcement')"
              :key="att.fileId"
              :href="att.proxyUrl"
              target="_blank"
              rel="noopener"
              class="text-primary hover:underline"
            >{{ attachmentLabel(att) }}</a>
            <Button
              v-if="props.loggedIn"
              type="button"
              variant="ghost"
              size="icon"
              class="ml-auto"
              :class="{ 'text-amber-500 hover:text-amber-500': props.watchlistIds.has(watchlistKey(a)) }"
              :title="props.watchlistIds.has(watchlistKey(a)) ? $t('search.removeFromWatchlist') : $t('search.addToWatchlist')"
              @click="emit('toggle-watchlist', a)"
            >
              <Star class="h-4 w-4" :class="{ 'fill-current': props.watchlistIds.has(watchlistKey(a)) }" />
            </Button>
            <NuxtLink :to="`/objekt/${encodeURIComponent(a.platform)}/${encodeURIComponent(a.externalId)}`" :class="props.loggedIn ? '' : 'ml-auto'" class="text-primary hover:underline">
              {{ $t('search.detailsLink') }}
            </NuxtLink>
          </footer>
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
