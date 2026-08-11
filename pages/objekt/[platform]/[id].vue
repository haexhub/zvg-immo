<script setup lang="ts">
import { classifyPropertyType } from '~/lib/property-type'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { auctionPhotoUrls } from '~/lib/auction-photos'
import { safeHref } from '~/lib/utils'
import { useAuctionDetailTranslation } from '~/composables/useAuctionDetailTranslation'
import { ArrowLeft } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const platform = String(route.params.platform)
const id = String(route.params.id)
const { t, locale } = useI18n()
const propertyTypeLabel = usePropertyTypeLabel()
const { data: a, error, pending } = await useFetch<AuctionDetail | null>(
  `/api/auction/${platform}/${id}`,
  { default: () => null },
)

const {
  translationPending,
  displayTitle,
  displayAddress,
  displayDescription,
  displayDocumentSummary,
  displayExtraction,
  titleTranslated,
  descriptionTranslated,
  auctionDataTranslating,
  propertyDataTranslating,
  amenitiesTranslating,
  descriptionTranslating,
  defectsTranslating,
  encumbrancesTranslating,
  constructionTranslating,
  locationCharacterTranslating,
  planningNotesTranslating,
  parcelsTranslating,
} = await useAuctionDetailTranslation({ auction: a, platform, id })

// Admin-only "Technik" link (docs/plans/2026-08-08-admin-auktions-technikseite.md,
// WP-3) — probed client-side only so an unauthenticated visitor's SSR HTML
// never reveals that the link exists.
const adminAuthed = ref(false)
if (import.meta.client) {
  $fetch<{ authed: boolean }>('/api/settings/session', { cache: 'no-store' })
    .then((res) => { adminAuthed.value = res.authed })
    .catch(() => { adminAuthed.value = false })
}

function category(): { id: string; label: string } | null {
  if (!a.value) return null
  const pt = a.value.extraction?.propertyType
  if (pt) return { id: pt, label: propertyTypeLabel(pt) }
  const fallback = classifyPropertyType(a.value.title)
  return fallback.id === 'unbekannt' ? null : { id: fallback.id, label: propertyTypeLabel(fallback.id, fallback.label) }
}

// Photo URLs: native foto attachments (when present) first, then extracted
// embedded photos from the Gutachten/Exposé PDF. Segments are
// encodeURIComponent'd — the API endpoint validates them against a strict
// allow-list, but the URL itself needs to be well-formed before we get there.
const photoUrls = computed<string[]>(() => {
  return a.value ? auctionPhotoUrls(a.value) : []
})

// The normal description contains both the source listing and the detailed,
// pre-generated synthesis across every listing-specific document. This
// replaces the former separate on-demand AI-summary card.
const combinedDescription = computed(() => {
  const parts = [
    displayDescription.value?.trim(),
    displayDocumentSummary.value?.trim(),
  ].filter((part): part is string => !!part)
  return [...new Set(parts)].join('\n\n')
})

// The list page keeps its full filter/sort state in the URL, so a plain
// browser-back restores it. Only fall back to a bare /search (via NuxtLink's
// own navigate()) when there's no real in-app page to go back to, e.g. the
// detail page was opened directly — see plugins/track-in-app-history.client.ts.
const hasInAppHistory = useState('has-in-app-history', () => false)
function onBackClick(event: MouseEvent, navigate: (event?: MouseEvent) => void): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  if (hasInAppHistory.value) router.back()
  else navigate()
}

const requestOrigin = useRequestURL().origin
const canonicalUrl = computed(() => `${requestOrigin}${route.path}`)
const metaDescription = computed(() => {
  const text = combinedDescription.value.trim()
  if (!text) return t('site.description')
  return text.length > 300 ? `${text.slice(0, 297)}…` : text
})
const ogImageUrl = computed(() => (photoUrls.value[0] ? `${requestOrigin}${photoUrls.value[0]}` : null))

function auctionJsonLd(auction: AuctionDetail): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: displayTitle.value || auction.authority,
    description: metaDescription.value,
    url: canonicalUrl.value,
    ...(ogImageUrl.value ? { image: ogImageUrl.value } : {}),
    ...(displayAddress.value ? {
      address: { '@type': 'PostalAddress', streetAddress: displayAddress.value, addressCountry: auction.country.toUpperCase() },
    } : {}),
    ...(auction.lat != null && auction.lng != null ? {
      geo: { '@type': 'GeoCoordinates', latitude: auction.lat, longitude: auction.lng },
    } : {}),
    ...(auction.marketValueEur != null ? {
      offers: {
        '@type': 'Offer',
        price: auction.marketValueEur,
        priceCurrency: 'EUR',
        availability: auction.cancelled ? 'https://schema.org/Discontinued' : 'https://schema.org/InStock',
      },
    } : {}),
  }
}

useHead(() => ({
  title: displayTitle.value
    ? `${displayTitle.value} · ${a.value?.authority}`
    : t('objektDetail.untitled'),
  meta: [
    { name: 'description', content: metaDescription.value },
    { property: 'og:title', content: displayTitle.value || t('objektDetail.untitled') },
    { property: 'og:description', content: metaDescription.value },
    { property: 'og:url', content: canonicalUrl.value },
    { property: 'og:type', content: 'website' },
    ...(ogImageUrl.value ? [{ property: 'og:image', content: ogImageUrl.value }] : []),
    { name: 'twitter:card', content: ogImageUrl.value ? 'summary_large_image' : 'summary' },
  ],
  link: [{ rel: 'canonical', href: canonicalUrl.value }],
  script: a.value
    ? [{
        type: 'application/ld+json',
        // `<` escaped so a crawled title/address can't smuggle a literal
        // script-closing tag out of this block — JSON.stringify alone doesn't escape it.
        innerHTML: JSON.stringify(auctionJsonLd(a.value)).replace(/</g, '\\u003c'),
      }]
    : [],
}))
</script>

<template>
  <main class="px-4 py-6">
    <div class="max-w-7xl mx-auto">
    <div class="mb-4">
      <NuxtLink v-slot="{ href, navigate }" to="/search" custom>
        <a :href="href ?? undefined" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" @click="onBackClick($event, navigate)">
          <ArrowLeft class="h-4 w-4" /> {{ $t('objektDetail.back') }}
        </a>
      </NuxtLink>
    </div>

    <p v-if="pending" class="py-12 text-center text-muted-foreground">{{ $t('objektDetail.loading') }}</p>
    <p v-else-if="error || !a" class="py-12 text-center text-destructive">
      {{ error?.statusMessage || error?.message || $t('objektDetail.notFound') }}
    </p>

    <template v-else>
      <header class="mb-6 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <Badge v-if="category()" class="bg-primary/10 text-primary hover:bg-primary/10">{{ category()?.label }}</Badge>
          <Badge variant="secondary">{{ a.authority }}</Badge>
          <Badge v-if="a.region" variant="outline">{{ a.region }}</Badge>
          <Badge v-if="a.cancelled" variant="destructive">{{ $t('objektDetail.cancelled') }}</Badge>
          <span class="font-mono text-muted-foreground">{{ a.caseNumber }}</span>
          <NuxtLink
            v-if="adminAuthed"
            :to="`/admin/auktion/${platform}/${id}`"
            class="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {{ $t('objektDetail.technicalLink') }}
          </NuxtLink>
        </div>
        <div class="flex flex-wrap items-baseline gap-2">
          <h1 class="text-2xl font-bold leading-tight">{{ displayTitle || $t('objektDetail.untitled') }}</h1>
          <TranslationPendingBadge v-if="translationPending" />
          <span v-if="titleTranslated" class="text-xs text-muted-foreground">({{ $t('objektDetail.autoTranslatedHint') }})</span>
        </div>
        <p v-if="displayAddress" class="text-muted-foreground">{{ displayAddress }}</p>
      </header>

      <AuctionPhotoGallery :photos="photoUrls" :alt-base="displayTitle || $t('objektDetail.fallbackTitle')" />

      <div class="space-y-8">
        <div class="space-y-8">
          <AuctionDetailOverviewSections
            :auction="a"
            :display-title="displayTitle"
            :display-address="displayAddress"
            :display-extraction="displayExtraction"
            :combined-description="combinedDescription"
            :auction-data-translating="auctionDataTranslating"
            :property-data-translating="propertyDataTranslating"
            :amenities-translating="amenitiesTranslating"
            :description-translating="descriptionTranslating"
            :description-translated="descriptionTranslated"
          />

          <AuctionDetailInsightsSection
            :extraction="displayExtraction"
            :defects-translating="defectsTranslating"
            :encumbrances-translating="encumbrancesTranslating"
            :construction-translating="constructionTranslating"
            :location-character-translating="locationCharacterTranslating"
            :planning-notes-translating="planningNotesTranslating"
            :parcels-translating="parcelsTranslating"
          />

          <AuctionRelatedAuctionsSection :related-auctions="a.relatedAuctions" />
        </div>

        <CostCalculator v-if="a.country === 'de'" :market-value-eur="a.marketValueEur" :region="a.region" />

        <DetailSectionCard v-if="a.country === 'de'" :title="$t('objektDetail.safetyNoticeTitle')">
          <p class="text-base leading-relaxed text-foreground/85">{{ $t('objektDetail.safetyNoticeText') }}</p>
        </DetailSectionCard>
      </div>

      <AuctionDetailLocationSection :auction="a" :display-address="displayAddress" />

      <footer class="mt-10 border-t pt-6 text-sm leading-relaxed text-foreground/80">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 class="text-base font-semibold text-foreground">{{ $t('objektDetail.sourcesDisclaimerTitle') }}</h2>
            <p class="mt-1 max-w-3xl">{{ $t('objektDetail.sourcesDisclaimerText') }}</p>
          </div>
          <Button v-if="a.pdfUrlUpstream" as-child variant="outline" size="sm" class="shrink-0">
            <a :href="safeHref(a.pdfUrlUpstream)" target="_blank" rel="noopener">{{ $t('objektDetail.announcementOriginal') }}</a>
          </Button>
        </div>
      </footer>
    </template>
    </div>
  </main>
</template>
