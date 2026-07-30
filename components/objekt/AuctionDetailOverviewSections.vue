<script setup lang="ts">
import type { Component } from 'vue'
import type { Feature } from '~/lib/features'
import type { Attachment } from '~/types/auction'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { ATTACHMENT_KIND_ORDER } from '~/lib/auction-constants'
import { safeHref } from '~/lib/utils'
import { googleCalendarUrl, icsDataUrl, outlookCalendarUrl } from '~/lib/calendar-links'
import { useAuctionDetailFormatters } from '~/composables/useAuctionDetailFormatters'
import {
  Accessibility,
  Bath,
  BrickWall,
  Building2,
  CalendarPlus,
  ChartNoAxesColumn,
  ChefHat,
  ChevronDown,
  FileText,
  Flame,
  Heater,
  Layers3,
  Mountain,
  ParkingSquare,
  ShieldAlert,
  ShowerHead,
  TreePine,
  Warehouse,
  Waves,
} from 'lucide-vue-next'

const props = defineProps<{
  auction: AuctionDetail
  displayTitle: string | null
  displayExtraction: AuctionDetail['extraction'] | null
  combinedDescription: string
  auctionDataTranslating: boolean
  propertyDataTranslating: boolean
  amenitiesTranslating: boolean
  descriptionTranslating: boolean
  descriptionTranslated: boolean
}>()

const MARKET_COMPARISON_MIN_SAMPLES = 5

const { t } = useI18n()
const intlLocale = useIntlLocale()
const attachmentKindLabelFn = useAttachmentKindLabel()
const conditionLabel = useConditionLabel()
const featureLabel = useFeatureLabel()
const {
  currency,
  formatPrice,
  formatNative,
  formatDate,
  formatArea,
  formatCount,
  formatPricePerSqm,
  formatPercent,
  formatShortDate,
  icsFilename,
} = useAuctionDetailFormatters()

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

const hasPropertyData = computed(() => {
  const e = props.displayExtraction
  if (!e) return false
  return e.landAreaSqm != null || e.livingAreaSqm != null || e.yearBuilt != null
    || e.lastRenovationYear != null || e.rooms != null || (e.units != null && e.units > 1)
    || e.bedrooms != null || e.bathrooms != null || e.floor != null || pricePerSqm.value != null
    || !!e.condition || !!e.renovationNotes
})

const priceAreaSqm = computed(() => {
  const e = props.auction.extraction
  return e?.livingAreaSqm ?? e?.landAreaSqm ?? null
})

const pricePerSqm = computed(() => {
  if (props.auction.marketValueEur == null || priceAreaSqm.value == null || priceAreaSqm.value <= 0) return null
  return props.auction.marketValueEur / priceAreaSqm.value
})

const pricePerSqmBasis = computed(() => {
  const e = props.auction.extraction
  if (!e || pricePerSqm.value == null) return null
  return e.livingAreaSqm != null ? t('objektDetail.pricePerSqmLivingArea') : t('objektDetail.pricePerSqmLandArea')
})

const marketComparison = computed(() => props.auction.locationEnrichment?.marketComparison ?? null)
const showMarketComparison = computed(() => {
  const m = marketComparison.value
  return !!m && m.samples >= MARKET_COMPARISON_MIN_SAMPLES && m.verdict !== 'insufficient_data'
})
const landValueBaseline = computed(() => props.auction.locationEnrichment?.landValueBaseline ?? null)
const hazardAssessments = computed(() => props.auction.locationEnrichment?.hazards ?? [])
const showHazards = computed(() => hazardAssessments.value.length > 0)

const groupedAttachments = computed<Array<{ kind: string, label: string, items: Attachment[] }>>(() => {
  const byKind = new Map<string, Attachment[]>()
  for (const att of props.auction.attachments) {
    const list = byKind.get(att.kind) ?? []
    list.push(att)
    byKind.set(att.kind, list)
  }
  return ATTACHMENT_KIND_ORDER
    .filter((kind) => byKind.has(kind))
    .map((kind) => ({ kind, label: attachmentKindLabelFn(kind, kind), items: byKind.get(kind)! }))
})

const flatAttachments = computed(() => groupedAttachments.value.flatMap(
  (group) => group.items.map((att) => ({ att, groupLabel: group.label })),
))

const calendarEvent = computed(() => {
  if (!props.auction.auctionDateIso) return null
  return {
    title: props.displayTitle ?? t('objektDetail.untitled'),
    description: `${props.auction.authority} · ${props.auction.caseNumber}`,
    location: props.auction.address ?? undefined,
    startIso: props.auction.auctionDateIso,
  }
})

const amenityItems = computed<AmenityItem[]>(() => {
  const e = props.displayExtraction
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

function showOriginalPrice(): boolean {
  return !!props.auction.marketValueText && (props.auction.currency ?? 'EUR') !== currency.value
}

function attachmentHref(att: Attachment): string | undefined {
  if (props.auction.platform === 'bg-zapori') {
    return `/api/bg-zapori-document/${props.auction.externalId}/${att.fileId}`
  }
  return safeHref(att.proxyUrl)
}

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
</script>

<template>
  <DetailSectionCard :title="$t('objektDetail.auctionDataTitle')">
    <template v-if="auctionDataTranslating" #action>
      <TranslationPendingBadge />
    </template>
    <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
      <div>
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.marketValue') }}</dt>
        <dd class="text-lg font-semibold tabular-nums">{{ formatPrice(auction.marketValueEur) }}</dd>
        <dd v-if="showOriginalPrice()" class="text-xs text-muted-foreground">
          {{ $t('objektDetail.original', { value: auction.marketValueText }) }}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.versteigerungstermin') }}</dt>
        <dd class="text-sm font-medium">{{ formatDate(auction.auctionDateIso, auction.auctionDateText) }}</dd>
      </div>
      <div v-if="auction.startingBid != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.startingBid') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ formatNative(auction.startingBid, auction.currency) }}</dd>
      </div>
      <div v-if="auction.currentBid != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.currentBid') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ formatNative(auction.currentBid, auction.currency) }}</dd>
      </div>
      <div v-if="displayExtraction?.securityDeposit != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.securityDeposit') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ formatNative(displayExtraction.securityDeposit, auction.currency) }}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.authority') }}</dt>
        <dd class="text-sm font-medium">{{ auction.authority }}</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.caseNumber') }}</dt>
        <dd class="text-sm font-mono">{{ auction.caseNumber }}</dd>
      </div>
    </dl>
    <p v-if="displayExtraction?.biddingNotes" class="mt-4 text-xs text-muted-foreground">
      {{ $t('objektDetail.biddingNotes', { note: displayExtraction.biddingNotes }) }}
    </p>
    <div v-if="calendarEvent || flatAttachments.length > 0" class="mt-5 flex flex-wrap gap-2">
      <details v-if="calendarEvent" class="group relative">
        <summary
          class="inline-flex h-8 cursor-pointer list-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium shadow-xs outline-none transition-all hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 dark:bg-input/30 dark:border-input dark:hover:bg-input/50 [&::-webkit-details-marker]:hidden"
        >
          <CalendarPlus class="h-4 w-4" />
          <span>{{ $t('objektDetail.saveToCalendar') }}</span>
          <ChevronDown class="h-4 w-4 opacity-50 transition-transform group-open:rotate-180" />
        </summary>
        <div class="absolute left-0 z-50 mt-2 w-max min-w-64 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <a :href="googleCalendarUrl(calendarEvent)" target="_blank" rel="noopener" class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
            <CalendarPlus class="h-4 w-4 text-muted-foreground" /> {{ $t('objektDetail.addToGoogleCalendar') }}
          </a>
          <a :href="outlookCalendarUrl(calendarEvent)" target="_blank" rel="noopener" class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
            <CalendarPlus class="h-4 w-4 text-muted-foreground" /> {{ $t('objektDetail.addToOutlookCalendar') }}
          </a>
          <a :href="icsDataUrl(calendarEvent)" :download="icsFilename(auction.caseNumber)" class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
            <CalendarPlus class="h-4 w-4 text-muted-foreground" /> {{ $t('objektDetail.downloadIcs') }}
          </a>
        </div>
      </details>

      <details v-if="flatAttachments.length > 0" class="group relative">
        <summary
          class="inline-flex h-8 cursor-pointer list-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium shadow-xs outline-none transition-all hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 dark:bg-input/30 dark:border-input dark:hover:bg-input/50 [&::-webkit-details-marker]:hidden"
        >
          <FileText class="h-4 w-4" />
          <span>{{ $t('objektDetail.openFilesMenu') }}</span>
          <ChevronDown class="h-4 w-4 opacity-50 transition-transform group-open:rotate-180" />
        </summary>
        <div class="absolute left-0 z-50 mt-2 w-max min-w-64 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <a
            v-for="{ att, groupLabel } in flatAttachments"
            :key="att.fileId"
            :href="attachmentHref(att)"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <FileText class="h-4 w-4 text-muted-foreground" />
            <span class="min-w-0 truncate">{{ att.label || att.filename || groupLabel }}</span>
          </a>
        </div>
      </details>
    </div>
  </DetailSectionCard>

  <DetailSectionCard v-if="hasPropertyData" :title="$t('objektDetail.propertyDataTitle')">
    <template v-if="propertyDataTranslating" #action>
      <TranslationPendingBadge />
    </template>
    <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
      <div v-if="displayExtraction?.landAreaSqm != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landArea') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ formatArea(displayExtraction.landAreaSqm) }}</dd>
      </div>
      <div v-if="displayExtraction?.livingAreaSqm != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.livingArea') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ formatArea(displayExtraction.livingAreaSqm) }}</dd>
      </div>
      <div v-if="displayExtraction?.yearBuilt != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.yearBuilt') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ displayExtraction.yearBuilt }}</dd>
      </div>
      <div v-if="displayExtraction?.lastRenovationYear != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.lastRenovationYear') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ displayExtraction.lastRenovationYear }}</dd>
      </div>
      <div v-if="displayExtraction?.rooms != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.rooms') }}</dt>
        <dd class="text-sm font-medium">{{ formatCount(displayExtraction.rooms) }}</dd>
      </div>
      <div v-if="displayExtraction?.bedrooms != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.bedrooms') }}</dt>
        <dd class="text-sm font-medium">{{ formatCount(displayExtraction.bedrooms) }}</dd>
      </div>
      <div v-if="displayExtraction?.bathrooms != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.bathrooms') }}</dt>
        <dd class="text-sm font-medium">{{ formatCount(displayExtraction.bathrooms) }}</dd>
      </div>
      <div v-if="displayExtraction?.floor">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.floor') }}</dt>
        <dd class="text-sm font-medium">{{ displayExtraction.floor }}</dd>
      </div>
      <div v-if="displayExtraction?.units != null && displayExtraction.units > 1">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.units') }}</dt>
        <dd class="text-sm font-medium">{{ displayExtraction.units }}</dd>
      </div>
      <div v-if="pricePerSqm != null">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.pricePerSqm') }}</dt>
        <dd class="text-sm font-medium tabular-nums">{{ formatPricePerSqm(pricePerSqm) }}</dd>
        <dd v-if="pricePerSqmBasis" class="text-xs text-muted-foreground">{{ pricePerSqmBasis }}</dd>
      </div>
      <div v-if="displayExtraction?.condition">
        <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.condition') }}</dt>
        <dd class="text-sm font-medium">{{ conditionLabel(displayExtraction.condition) }}</dd>
      </div>
    </dl>
    <p v-if="displayExtraction?.source === 'llm'" class="mt-4 text-xs text-muted-foreground">
      {{ $t('objektDetail.extractionNotice', { confidence: displayExtraction.confidence === 'high' ? $t('objektDetail.confidenceHigh') : $t('objektDetail.confidenceLow') }) }}
    </p>
    <p v-if="displayExtraction?.renovationNotes" class="mt-1 text-xs text-muted-foreground">
      {{ $t('objektDetail.renovationNotes', { note: displayExtraction.renovationNotes }) }}
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
    <template v-if="amenitiesTranslating" #action>
      <TranslationPendingBadge />
    </template>
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
    <template v-if="descriptionTranslating" #action>
      <TranslationPendingBadge />
    </template>
    <template v-if="descriptionTranslated" #subtitle>{{ $t('objektDetail.autoTranslatedHint') }}</template>
    <DescriptionAccordion :text="combinedDescription" />
  </DetailSectionCard>

  <LawyerContact :platform="auction.platform" :external-id="auction.externalId" :country="auction.country" />
</template>
