<script setup lang="ts">
import type { Component } from 'vue'
import { classifyPropertyType } from '~/lib/property-type'
import type { Feature } from '~/lib/features'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import type { Attachment } from '~/types/auction'
import { auctionPhotoUrls } from '~/lib/auction-photos'
import { ATTACHMENT_KIND_ORDER } from '~/lib/auction-constants'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { safeHref } from '~/lib/utils'
import { googleCalendarUrl, icsDataUrl, outlookCalendarUrl } from '~/lib/calendar-links'
import {
  Accessibility,
  ArrowLeft,
  Bath,
  BrickWall,
  Building2,
  CalendarPlus,
  ChartNoAxesColumn,
  ChefHat,
  Flame,
  Heater,
  Layers3,
  Mountain,
  ParkingSquare,
  ShowerHead,
  ShieldAlert,
  TreePine,
  Warehouse,
  Waves,
} from 'lucide-vue-next'

const route = useRoute()
const platform = String(route.params.platform)
const id = String(route.params.id)
const { t, locale } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay, nativeToDisplay } = useCurrencyDisplay()
const propertyTypeLabel = usePropertyTypeLabel()
const attachmentKindLabelFn = useAttachmentKindLabel()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()
const MARKET_COMPARISON_MIN_SAMPLES = 5

const { data: a, error, pending } = await useFetch<AuctionDetail | null>(
  `/api/auction/${platform}/${id}`,
  { default: () => null },
)

// Auto-translated title/description/document synthesis (WP-8): loaded silently whenever the
// viewer's locale differs from the auction's source language — unlike the
// original content, this replaces text the user would otherwise see
// untranslated. Falls back to the original text (via the
// computed below) while pending or on error.
const translatedTitle = ref<string | null>(null)
const translatedDescription = ref<string | null>(null)
const translatedDocumentSummary = ref<string | null>(null)

const displayTitle = computed(() => translatedTitle.value ?? a.value?.title ?? null)
const displayDescription = computed(() => translatedDescription.value ?? a.value?.description ?? null)
const displayDocumentSummary = computed(
  () => translatedDocumentSummary.value ?? a.value?.extraction?.documentSummary ?? null,
)
const titleTranslated = computed(() => translatedTitle.value != null)
const descriptionTranslated = computed(
  () => translatedDescription.value != null || translatedDocumentSummary.value != null,
)

const translationSeq = ref(0)
watch([a, locale], async ([val, loc]) => {
  const seq = ++translationSeq.value
  translatedTitle.value = null
  translatedDescription.value = null
  translatedDocumentSummary.value = null
  if (!val) return
  if (val.title == null && val.description == null && val.extraction?.documentSummary == null) return
  if (isPassthroughLanguage(val.country, loc as ContentTargetLang)) return

  try {
    const res = await $fetch<{
      title: string | null
      description: string | null
      documentSummary: string | null
    }>(
      `/api/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/translation`,
      { method: 'POST', query: { lang: loc } },
    )
    // A newer (a, locale) change already superseded this request; dropping the
    // result avoids a slow earlier response overwriting fresher content.
    if (seq !== translationSeq.value) return
    translatedTitle.value = res.title
    translatedDescription.value = res.description
    translatedDocumentSummary.value = res.documentSummary
  } catch {
    // Best-effort: keep showing the original text (see displayTitle/displayDescription).
  }
}, { immediate: true })

function category(): { id: string; label: string } | null {
  if (!a.value) return null
  const pt = a.value.extraction?.propertyType
  if (pt) return { id: pt, label: propertyTypeLabel(pt) }
  const fallback = classifyPropertyType(a.value.title)
  return fallback.id === 'unbekannt' ? null : { id: fallback.id, label: propertyTypeLabel(fallback.id, fallback.label) }
}

function formatPrice(marketValueEur: number | null): string {
  const converted = eurToDisplay(marketValueEur)
  if (converted == null) return '–'
  return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}

// Shown whenever the auction's native currency differs from the viewer's
// display currency — including a EUR-native (e.g. German) auction viewed by
// a non-EUR user, which formatPrice() alone wouldn't make obvious.
function showOriginalPrice(): boolean {
  return !!a.value?.marketValueText && (a.value?.currency ?? 'EUR') !== currency.value
}

const hasPropertyData = computed(() => {
  const e = a.value?.extraction
  if (!e) return false
  return e.landAreaSqm != null || e.livingAreaSqm != null || e.yearBuilt != null
    || e.lastRenovationYear != null || e.rooms != null || (e.units != null && e.units > 1)
    || e.bedrooms != null || e.bathrooms != null || e.floor != null || pricePerSqm.value != null
    || !!e.condition || !!e.renovationNotes
})

// Online-bidding-style platforms (Biddit, si, fi, hu, pl, boe, ca,
// us-bid4assets) additionally publish a starting bid and/or a live current
// bid — German-court-style platforms never set these, so this card simply
// gains no extra rows there (see Auction.startingBid/currentBid in
// types/auction.ts for why "geringstes Gebot" itself can't be one of them).
function formatNative(amount: number | null | undefined, sourceCurrency: string | null | undefined): string | null {
  const converted = nativeToDisplay(amount ?? null, sourceCurrency)
  if (converted == null) return null
  return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString(intlLocale.value, {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatArea(n: number | null): string {
  if (n == null) return '–'
  return `${n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })} m²`
}

function formatCount(n: number | null | undefined): string {
  if (n == null) return '–'
  return n.toLocaleString(intlLocale.value, { maximumFractionDigits: 1 })
}

function formatPricePerSqm(n: number | null): string {
  if (n == null) return '–'
  const converted = eurToDisplay(n)
  if (converted == null) return '–'
  return `${converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })}/m²`
}

function formatPercent(n: number | null): string {
  if (n == null) return '–'
  return `${n > 0 ? '+' : ''}${n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })}%`
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(intlLocale.value, { day: '2-digit', month: 'short', year: 'numeric' })
}

const priceAreaSqm = computed(() => {
  const e = a.value?.extraction
  return e?.livingAreaSqm ?? e?.landAreaSqm ?? null
})

const pricePerSqm = computed(() => {
  if (a.value?.marketValueEur == null || priceAreaSqm.value == null || priceAreaSqm.value <= 0) return null
  return a.value.marketValueEur / priceAreaSqm.value
})

const pricePerSqmBasis = computed(() => {
  const e = a.value?.extraction
  if (!e || pricePerSqm.value == null) return null
  return e.livingAreaSqm != null ? t('objektDetail.pricePerSqmLivingArea') : t('objektDetail.pricePerSqmLandArea')
})

const marketComparison = computed(() => a.value?.locationEnrichment?.marketComparison ?? null)
const showMarketComparison = computed(() => {
  const m = marketComparison.value
  return !!m && m.samples >= MARKET_COMPARISON_MIN_SAMPLES && m.verdict !== 'insufficient_data'
})
const landValueBaseline = computed(() => a.value?.locationEnrichment?.landValueBaseline ?? null)

const hazardAssessments = computed(() => a.value?.locationEnrichment?.hazards ?? [])
const showHazards = computed(() => hazardAssessments.value.length > 0)

function marketVerdictClass(verdict: string): string {
  if (verdict === 'cheaper') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (verdict === 'more_expensive') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-slate-200 bg-slate-50 text-slate-700'
}

function marketVerdictLabel(verdict: string): string {
  return t(`objektDetail.marketVerdict.${verdict}`)
}

function hazardIcon(hazard: string): Component {
  if (hazard === 'flood') return Waves
  if (hazard === 'wildfire') return Flame
  if (hazard === 'avalanche') return Mountain
  return ShieldAlert
}

function hazardLabel(hazard: string): string {
  return t(`objektDetail.hazard.${hazard}`)
}

function hazardStatusLabel(status: string): string {
  return t(`objektDetail.hazardStatus.${status}`)
}

function hazardSeverityLabel(severity: string): string {
  return t(`objektDetail.hazardSeverity.${severity}`)
}

function hazardStatusClass(status: string): string {
  if (status === 'inside') return 'text-destructive'
  if (status === 'nearby') return 'text-amber-700'
  if (status === 'outside') return 'text-emerald-700'
  return 'text-muted-foreground'
}

// Photo URLs: native foto attachments (when present) first, then extracted
// embedded photos from the Gutachten/Exposé PDF. Segments are
// encodeURIComponent'd — the API endpoint validates them against a strict
// allow-list, but the URL itself needs to be well-formed before we get there.
const photoUrls = computed<string[]>(() => {
  return a.value ? auctionPhotoUrls(a.value) : []
})

const groupedAttachments = computed<Array<{ kind: string; label: string; items: Attachment[] }>>(() => {
  if (!a.value) return []
  const byKind = new Map<string, Attachment[]>()
  for (const att of a.value.attachments) {
    const list = byKind.get(att.kind) ?? []
    list.push(att)
    byKind.set(att.kind, list)
  }
  return ATTACHMENT_KIND_ORDER
    .filter((k) => byKind.has(k))
    .map((k) => ({ kind: k, label: attachmentKindLabelFn(k, k), items: byKind.get(k)! }))
})

// Flattened for the sidebar "Dateien" card, which lists every attachment as a
// single row of buttons rather than grouping by kind — falls back to the
// kind label (e.g. "Gutachten") when an attachment has neither its own label
// nor filename.
const flatAttachments = computed(() => groupedAttachments.value.flatMap(
  (g) => g.items.map((att) => ({ att, groupLabel: g.label })),
))

function formatLandValue(eurPerSqm: number): string {
  return `${eurPerSqm.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })} €/m²`
}

type AmenityItem = { key: string; label: string; value?: string; icon: Component }

const FEATURE_ICONS: Partial<Record<Feature, Component>> = {
  balkon: Building2,
  terrasse: TreePine,
  garten: TreePine,
  garage: Warehouse,
  stellplatz: ParkingSquare,
  keller: Warehouse,
  dachgeschoss: Mountain,
  aufzug: Layers3,
  einbaukueche: ChefHat,
  kamin: Flame,
  barrierefrei: Accessibility,
  zentralheizung: Heater,
  fussbodenheizung: Heater,
  denkmalschutz: BrickWall,
  vermietet: Building2,
}

const amenityItems = computed<AmenityItem[]>(() => {
  const e = a.value?.extraction
  if (!e) return []
  const items: AmenityItem[] = []
  const seen = new Set<string>()
  const add = (item: AmenityItem) => {
    if (seen.has(item.key)) return
    seen.add(item.key)
    items.push(item)
  }

  for (const f of e.features ?? []) {
    add({ key: `feature:${f}`, label: featureLabel(f), icon: FEATURE_ICONS[f] ?? Building2 })
  }
  if (e.heating) add({ key: 'heating', label: t('objektDetail.heating'), value: e.heating, icon: Heater })
  if (e.bathroomHasTub === true) add({ key: 'bathroomHasTub', label: t('objektDetail.bathroomHasTub'), icon: Bath })
  if (e.bathroomHasTub === false) add({ key: 'bathroomHasTub', label: t('objektDetail.bathroomHasNoTub'), icon: Bath })
  if (e.bathroomHasShower === true) add({ key: 'bathroomHasShower', label: t('objektDetail.bathroomHasShower'), icon: ShowerHead })
  if (e.bathroomHasShower === false) add({ key: 'bathroomHasShower', label: t('objektDetail.bathroomHasNoShower'), icon: ShowerHead })
  if (e.insights?.construction) {
    add({
      key: 'construction',
      label: t('objektDetail.constructionShort'),
      value: e.insights.construction,
      icon: BrickWall,
    })
  }
  return items
})

const planningNotesHasContent = computed(() => {
  const p = a.value?.extraction?.planningNotes
  return !!p && (
    p.monumentProtection != null ||
    p.contamination != null ||
    p.developmentPlan != null ||
    p.landConsolidation != null ||
    p.developmentCharges != null ||
    p.redevelopmentArea != null ||
    p.conservationArea != null
  )
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

// "Zu Kalender hinzufügen" (Gerichtsinformationen sidebar) — null while the
// Versteigerungstermin isn't a parseable timestamp (announcement-only listings).
const calendarEvent = computed(() => {
  if (!a.value?.auctionDateIso) return null
  return {
    title: displayTitle.value ?? t('objektDetail.untitled'),
    description: `${a.value.authority} · ${a.value.caseNumber}`,
    location: a.value.address ?? undefined,
    startIso: a.value.auctionDateIso,
  }
})

// Aktenzeichen routinely contain "/" (e.g. "12 K 34/26"), which the `download`
// attribute would otherwise treat as a path separator.
function icsFilename(caseNumber: string): string {
  return `${(caseNumber || 'termin').replace(/[/\\]/g, '-')}.ics`
}

useHead(() => ({
  title: displayTitle.value
    ? `${displayTitle.value} · ${a.value?.authority}`
    : t('objektDetail.untitled'),
}))
</script>

<template>
  <main class="px-4 py-6">
    <div class="max-w-7xl mx-auto">
    <div class="mb-4">
      <NuxtLink to="/search" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" /> {{ $t('objektDetail.back') }}
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
        </div>
        <div class="flex flex-wrap items-baseline gap-2">
          <h1 class="text-2xl font-bold leading-tight">{{ displayTitle || $t('objektDetail.untitled') }}</h1>
          <span v-if="titleTranslated" class="text-xs text-muted-foreground">({{ $t('objektDetail.autoTranslatedHint') }})</span>
        </div>
        <p v-if="a.address" class="text-muted-foreground">{{ a.address }}</p>
      </header>

      <AuctionPhotoGallery :photos="photoUrls" :alt-base="displayTitle || $t('objektDetail.fallbackTitle')" />

      <div class="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        <div class="lg:col-span-3 space-y-8">
          <DetailSectionCard :title="$t('objektDetail.auctionDataTitle')">
            <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.marketValue') }}</dt>
                <dd class="text-lg font-semibold tabular-nums">{{ formatPrice(a.marketValueEur) }}</dd>
                <dd
                  v-if="showOriginalPrice()"
                  class="text-xs text-muted-foreground"
                >
                  {{ $t('objektDetail.original', { value: a.marketValueText }) }}
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.auctionDate') }}</dt>
                <dd class="text-sm font-medium">{{ formatDate(a.auctionDateIso, a.auctionDateText) }}</dd>
              </div>
              <div v-if="a.startingBid != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.startingBid') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatNative(a.startingBid, a.currency) }}</dd>
              </div>
              <div v-if="a.currentBid != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.currentBid') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatNative(a.currentBid, a.currency) }}</dd>
              </div>
              <div v-if="a.extraction?.securityDeposit != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.securityDeposit') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatNative(a.extraction.securityDeposit, a.currency) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.authority') }}</dt>
                <dd class="text-sm font-medium">{{ a.authority }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.caseNumber') }}</dt>
                <dd class="text-sm font-mono">{{ a.caseNumber }}</dd>
              </div>
            </dl>
            <p v-if="a.extraction?.biddingNotes" class="mt-4 text-xs text-muted-foreground">
              {{ $t('objektDetail.biddingNotes', { note: a.extraction.biddingNotes }) }}
            </p>
          </DetailSectionCard>

          <DetailSectionCard v-if="hasPropertyData" :title="$t('objektDetail.propertyDataTitle')">
            <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
              <div v-if="a.extraction?.landAreaSqm != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landArea') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatArea(a.extraction.landAreaSqm) }}</dd>
              </div>
              <div v-if="a.extraction?.livingAreaSqm != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.livingArea') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatArea(a.extraction.livingAreaSqm) }}</dd>
              </div>
              <div v-if="a.extraction?.yearBuilt != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.yearBuilt') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ a.extraction.yearBuilt }}</dd>
              </div>
              <div v-if="a.extraction?.lastRenovationYear != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.lastRenovationYear') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ a.extraction.lastRenovationYear }}</dd>
              </div>
              <div v-if="a.extraction?.rooms != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.rooms') }}</dt>
                <dd class="text-sm font-medium">{{ formatCount(a.extraction.rooms) }}</dd>
              </div>
              <div v-if="a.extraction?.bedrooms != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.bedrooms') }}</dt>
                <dd class="text-sm font-medium">{{ formatCount(a.extraction.bedrooms) }}</dd>
              </div>
              <div v-if="a.extraction?.bathrooms != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.bathrooms') }}</dt>
                <dd class="text-sm font-medium">{{ formatCount(a.extraction.bathrooms) }}</dd>
              </div>
              <div v-if="a.extraction?.floor">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.floor') }}</dt>
                <dd class="text-sm font-medium">{{ a.extraction.floor }}</dd>
              </div>
              <div v-if="a.extraction?.units != null && a.extraction.units > 1">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.units') }}</dt>
                <dd class="text-sm font-medium">{{ a.extraction.units }}</dd>
              </div>
              <div v-if="pricePerSqm != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.pricePerSqm') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatPricePerSqm(pricePerSqm) }}</dd>
                <dd v-if="pricePerSqmBasis" class="text-xs text-muted-foreground">{{ pricePerSqmBasis }}</dd>
              </div>
              <div v-if="a.extraction?.condition">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.condition') }}</dt>
                <dd class="text-sm font-medium">{{ conditionLabel(a.extraction.condition) }}</dd>
              </div>
            </dl>
            <p
              v-if="a.extraction?.source === 'llm'"
              class="mt-4 text-xs text-muted-foreground"
            >
              {{ $t('objektDetail.extractionNotice', { confidence: a.extraction.confidence === 'high' ? $t('objektDetail.confidenceHigh') : $t('objektDetail.confidenceLow') }) }}
            </p>
            <p v-if="a.extraction?.renovationNotes" class="mt-1 text-xs text-muted-foreground">
              {{ $t('objektDetail.renovationNotes', { note: a.extraction.renovationNotes }) }}
            </p>
          </DetailSectionCard>

          <DetailSectionCard v-if="showMarketComparison && marketComparison" :title="$t('objektDetail.marketComparisonTitle')">
            <div class="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="outline" :class="marketVerdictClass(marketComparison.verdict)">
                <ChartNoAxesColumn class="h-3.5 w-3.5" />
                {{ marketVerdictLabel(marketComparison.verdict) }}
              </Badge>
              <span class="text-xs text-muted-foreground">
                {{ $t('objektDetail.marketComparisonSamples', { count: marketComparison.samples, region: marketComparison.regionLabel }) }}
              </span>
            </div>
            <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-4">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.objectPricePerSqm') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatPricePerSqm(marketComparison.pricePerSqm) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.regionalMedian') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatPricePerSqm(marketComparison.medianPricePerSqm) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.regionalRange') }}</dt>
                <dd class="text-sm font-medium tabular-nums">
                  {{ formatPricePerSqm(marketComparison.p25PricePerSqm) }} – {{ formatPricePerSqm(marketComparison.p75PricePerSqm) }}
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.deltaVsMedian') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatPercent(marketComparison.deltaPctVsMedian) }}</dd>
              </div>
            </dl>
            <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{{ $t('objektDetail.pricePerSqmBasisLabel') }} {{ marketComparison.basis === 'livingArea' ? $t('objektDetail.pricePerSqmLivingArea') : $t('objektDetail.pricePerSqmLandArea') }}</span>
              <a
                v-for="source in marketComparison.sources"
                :key="source.id"
                :href="safeHref(source.url)"
                target="_blank"
                rel="noopener"
                class="underline underline-offset-2 hover:text-foreground"
              >
                {{ source.label }}
              </a>
            </div>
            <p class="mt-3 text-xs text-muted-foreground">{{ $t('objektDetail.externalDataDisclaimer') }}</p>
          </DetailSectionCard>

          <DetailSectionCard v-if="landValueBaseline" :title="$t('objektDetail.landValueBaselineTitle')">
            <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landValueBaseline') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatPricePerSqm(landValueBaseline.valueEurPerSqm) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.region') }}</dt>
                <dd class="text-sm font-medium">{{ landValueBaseline.regionLabel }}</dd>
              </div>
              <div v-if="landValueBaseline.zoneLabel">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landValueZone') }}</dt>
                <dd class="text-sm font-medium">{{ landValueBaseline.zoneLabel }}</dd>
              </div>
            </dl>
            <p class="mt-4 text-xs text-muted-foreground">
              {{ $t('objektDetail.sourceChecked', { source: landValueBaseline.source.label, date: formatShortDate(landValueBaseline.checkedAt) }) }}
              <a :href="safeHref(landValueBaseline.source.url)" target="_blank" rel="noopener" class="ml-1 underline underline-offset-2 hover:text-foreground">
                {{ $t('objektDetail.sourceLink') }}
              </a>
            </p>
            <p class="mt-2 text-xs text-muted-foreground">{{ $t('objektDetail.landValueBaselineDisclaimer') }}</p>
          </DetailSectionCard>

          <DetailSectionCard v-if="showHazards" :title="$t('objektDetail.hazardsTitle')">
            <div class="divide-y rounded-md border">
              <div
                v-for="hazard in hazardAssessments"
                :key="`${hazard.hazard}:${hazard.sourceLabel}`"
                class="grid grid-cols-[auto_1fr] gap-3 p-3"
              >
                <component :is="hazardIcon(hazard.hazard)" class="mt-0.5 h-4 w-4 text-primary" />
                <div class="min-w-0">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <p class="text-sm font-medium">{{ hazardLabel(hazard.hazard) }}</p>
                    <p class="text-xs font-medium" :class="hazardStatusClass(hazard.status)">
                      {{ hazardStatusLabel(hazard.status) }}
                    </p>
                  </div>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ $t('objektDetail.hazardSeverityLabel') }} {{ hazardSeverityLabel(hazard.severity) }}
                    <span v-if="hazard.distanceMeters != null">
                      · {{ $t('objektDetail.hazardDistance', { meters: hazard.distanceMeters.toLocaleString(intlLocale, { maximumFractionDigits: 0 }) }) }}
                    </span>
                  </p>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ $t('objektDetail.sourceChecked', { source: hazard.sourceLabel, date: formatShortDate(hazard.checkedAt) }) }}
                    <a :href="safeHref(hazard.sourceUrl)" target="_blank" rel="noopener" class="ml-1 underline underline-offset-2 hover:text-foreground">
                      {{ $t('objektDetail.sourceLink') }}
                    </a>
                  </p>
                </div>
              </div>
            </div>
            <p class="mt-3 text-xs text-muted-foreground">{{ $t('objektDetail.externalDataDisclaimer') }}</p>
          </DetailSectionCard>

          <DetailSectionCard v-if="amenityItems.length" :title="$t('objektDetail.amenitiesTitle')">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div
                v-for="item in amenityItems"
                :key="item.key"
                class="flex min-h-14 items-start gap-3 rounded-md border bg-muted/20 px-3 py-2.5"
              >
                <component :is="item.icon" class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div class="min-w-0">
                  <p class="text-sm font-medium leading-snug">{{ item.label }}</p>
                  <p v-if="item.value" class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{{ item.value }}</p>
                </div>
              </div>
            </div>
          </DetailSectionCard>

          <DetailSectionCard v-if="combinedDescription" :title="$t('objektDetail.description')">
            <template v-if="descriptionTranslated" #subtitle>{{ $t('objektDetail.autoTranslatedHint') }}</template>
            <DescriptionAccordion :text="combinedDescription" />
          </DetailSectionCard>

          <LawyerContact :platform="a.platform" :external-id="a.externalId" :country="a.country" />

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <DetailSectionCard v-if="a.extraction?.insights?.defects?.length" :title="$t('objektDetail.defectsTitle')">
              <ul class="list-disc list-inside space-y-1 text-sm text-foreground/90">
                <li v-for="(defect, i) in a.extraction.insights.defects" :key="i">{{ defect }}</li>
              </ul>
            </DetailSectionCard>
            <DetailSectionCard v-if="a.extraction?.insights?.encumbrances?.length" :title="$t('objektDetail.encumbrancesTitle')">
              <ul class="list-disc list-inside space-y-1 text-sm text-foreground/90">
                <li v-for="(encumbrance, i) in a.extraction.insights.encumbrances" :key="i">{{ encumbrance }}</li>
              </ul>
            </DetailSectionCard>
            <DetailSectionCard v-if="a.extraction?.insights?.landValueEurPerSqm != null" :title="$t('objektDetail.landValueTitle')">
              <p class="text-sm font-medium tabular-nums">{{ formatLandValue(a.extraction.insights.landValueEurPerSqm) }}</p>
            </DetailSectionCard>
            <DetailSectionCard v-if="a.extraction?.insights?.construction" :title="$t('objektDetail.constructionTitle')">
              <p class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{{ a.extraction.insights.construction }}</p>
            </DetailSectionCard>
            <DetailSectionCard v-if="a.extraction?.insights?.locationCharacter" :title="$t('objektDetail.neighborhoodCharacter')">
              <p class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{{ a.extraction.insights.locationCharacter }}</p>
            </DetailSectionCard>
            <DetailSectionCard v-if="planningNotesHasContent" :title="$t('objektDetail.planningNotesTitle')">
              <dl class="space-y-2 text-sm">
                <div v-if="a.extraction?.planningNotes?.monumentProtection">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.monumentProtection') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.monumentProtection }}</dd>
                </div>
                <div v-if="a.extraction?.planningNotes?.contamination">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.contamination') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.contamination }}</dd>
                </div>
                <div v-if="a.extraction?.planningNotes?.developmentPlan">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.developmentPlan') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.developmentPlan }}</dd>
                </div>
                <div v-if="a.extraction?.planningNotes?.landConsolidation">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landConsolidation') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.landConsolidation }}</dd>
                </div>
                <div v-if="a.extraction?.planningNotes?.developmentCharges">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.developmentCharges') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.developmentCharges }}</dd>
                </div>
                <div v-if="a.extraction?.planningNotes?.redevelopmentArea">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.redevelopmentArea') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.redevelopmentArea }}</dd>
                </div>
                <div v-if="a.extraction?.planningNotes?.conservationArea">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.conservationArea') }}</dt>
                  <dd class="text-foreground/90">{{ a.extraction.planningNotes.conservationArea }}</dd>
                </div>
              </dl>
            </DetailSectionCard>
            <DetailSectionCard v-if="a.extraction?.planningNotes?.landParcels?.length" :title="$t('objektDetail.parcelsTitle')">
              <ul class="space-y-2 text-sm">
                <li v-for="(parcel, i) in a.extraction.planningNotes.landParcels" :key="i" class="flex items-baseline justify-between gap-3">
                  <span class="font-medium">{{ parcel.label }}</span>
                  <span class="text-foreground/90 text-right">
                    <span v-if="parcel.areaSqm != null" class="tabular-nums">{{ formatArea(parcel.areaSqm) }}</span>
                    <span v-if="parcel.use" class="block text-xs text-muted-foreground">{{ parcel.use }}</span>
                  </span>
                </li>
              </ul>
            </DetailSectionCard>
          </div>
        </div>

        <aside class="lg:col-span-2 space-y-6">
          <DetailSectionCard :title="$t('objektDetail.courtInfoTitle')">
            <dl class="space-y-3 text-sm">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.authority') }}</dt>
                <dd class="font-medium">{{ a.authority }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.versteigerungstermin') }}</dt>
                <dd class="font-medium">{{ formatDate(a.auctionDateIso, a.auctionDateText) }}</dd>
              </div>
            </dl>
            <div v-if="calendarEvent" class="flex flex-col gap-2 pt-4">
              <Button as-child variant="outline" size="sm">
                <a :href="googleCalendarUrl(calendarEvent)" target="_blank" rel="noopener">
                  <CalendarPlus class="h-4 w-4" /> {{ $t('objektDetail.addToGoogleCalendar') }}
                </a>
              </Button>
              <Button as-child variant="outline" size="sm">
                <a :href="outlookCalendarUrl(calendarEvent)" target="_blank" rel="noopener">
                  <CalendarPlus class="h-4 w-4" /> {{ $t('objektDetail.addToOutlookCalendar') }}
                </a>
              </Button>
              <Button as-child variant="outline" size="sm">
                <a :href="icsDataUrl(calendarEvent)" :download="icsFilename(a.caseNumber)">
                  <CalendarPlus class="h-4 w-4" /> {{ $t('objektDetail.downloadIcs') }}
                </a>
              </Button>
            </div>
          </DetailSectionCard>

          <CostCalculator v-if="a.country === 'de'" :market-value-eur="a.marketValueEur" :region="a.region" />

          <DetailSectionCard v-if="groupedAttachments.length > 0" :title="$t('objektDetail.filesTitle')">
            <div class="flex flex-wrap gap-2">
              <Button v-for="{ att, groupLabel } in flatAttachments" :key="att.fileId" as-child variant="outline" size="sm">
                <a :href="safeHref(att.proxyUrl)" target="_blank" rel="noopener">
                  {{ att.label || att.filename || groupLabel }}
                </a>
              </Button>
            </div>
          </DetailSectionCard>

          <DetailSectionCard :title="$t('objektDetail.sourcesDisclaimerTitle')">
            <div v-if="a.detailUrlUpstream || a.pdfUrlUpstream" class="mb-2 flex flex-wrap gap-2">
              <Button v-if="a.detailUrlUpstream" as-child variant="outline" size="sm">
                <a :href="safeHref(a.detailUrlUpstream)" target="_blank" rel="noopener">{{ $t('objektDetail.openDetailPage') }}</a>
              </Button>
              <Button v-if="a.pdfUrlUpstream" as-child variant="outline" size="sm">
                <a :href="safeHref(a.pdfUrlUpstream)" target="_blank" rel="noopener">{{ $t('objektDetail.announcementOriginal') }}</a>
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('objektDetail.sourcesDisclaimerText') }}</p>
          </DetailSectionCard>

          <DetailSectionCard v-if="a.country === 'de'" :title="$t('objektDetail.safetyNoticeTitle')">
            <p class="text-xs text-muted-foreground leading-relaxed">{{ $t('objektDetail.safetyNoticeText') }}</p>
          </DetailSectionCard>
        </aside>
      </div>

      <section v-if="a.lat != null && a.lng != null" class="mt-8 space-y-2">
        <h2 class="text-base font-semibold">{{ $t('objektDetail.location') }}</h2>
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
          <div class="lg:col-span-3">
            <AuctionDetailMap
              :lat="a.lat"
              :lng="a.lng"
              :label="a.address ?? undefined"
              :country="a.country"
              :hazards="a.locationEnrichment?.hazards"
            />
          </div>
          <DetailSectionCard class="lg:col-span-2" :title="$t('objektDetail.nearbyPlaces')">
            <PremiumFeatureLock :rows="3" />
          </DetailSectionCard>
        </div>
      </section>
    </template>
    </div>
  </main>
</template>
