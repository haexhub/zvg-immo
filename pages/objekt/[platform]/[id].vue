<script setup lang="ts">
import type { Component } from 'vue'
import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import { hasCompletedLlmAnalysis as extractionHasCompletedLlmAnalysis } from '~/lib/auction-filters'
import { classifyPropertyType } from '~/lib/property-type'
import type { Feature } from '~/lib/features'
import type { UsageIdea, UsageIdeaType } from '~/lib/usage-idea'
import type { RenovationCostCategory, RenovationCostItem } from '~/lib/renovation-cost'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import type {
  Attachment,
  LocationAirQualityLevel,
  LocationAmenityKind,
  LocationDemographicContext,
  LocationEnvironmentContext,
  LocationMobilityContext,
  LocationNoiseObservation,
  NearbyPlace,
  NearbyPlaceKind,
  NeighborhoodContext,
} from '~/types/auction'
import { auctionPhotoUrls } from '~/lib/auction-photos'
import { ATTACHMENT_KIND_ORDER } from '~/lib/auction-constants'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import {
  applyTranslatedExtractionTexts,
  extractTranslatableExtractionTexts,
  translationContentSource,
  type TranslatableExtractionTexts,
} from '~/lib/extraction-translation'
import { safeHref } from '~/lib/utils'
import { apiErrorMessage } from '~/lib/api-error'
import { fetchWithPendingRetry } from '~/lib/pending-retry'
import { googleCalendarUrl, icsDataUrl, outlookCalendarUrl } from '~/lib/calendar-links'
import {
  Accessibility,
  ArrowLeft,
  Bath,
  Blinds,
  BrickWall,
  Building2,
  CalendarPlus,
  ChartNoAxesColumn,
  ChefHat,
  ChevronDown,
  FileText,
  Flame,
  Heater,
  Home,
  Layers3,
  Lightbulb,
  Loader2,
  Mountain,
  ParkingSquare,
  ShowerHead,
  ShieldAlert,
  Sprout,
  SquareStack,
  Tractor,
  TreePine,
  Warehouse,
  Waves,
  Wrench,
  Zap,
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
const usageIdeaTypeLabel = useUsageIdeaTypeLabel()
const renovationCostCategoryLabel = useRenovationCostCategoryLabel()
const {
  payload: usageIdeas,
  pending: usageIdeasPending,
  error: usageIdeasError,
  generate: generateUsageIdeas,
} = useAuctionInsight<UsageIdea[]>('usage-ideas', platform, id)
const {
  payload: renovationCost,
  pending: renovationCostPending,
  error: renovationCostError,
  generate: generateRenovationCost,
} = useAuctionInsight<RenovationCostItem[]>('renovation-cost-estimate', platform, id)
const MARKET_COMPARISON_MIN_SAMPLES = 5

const { data: a, error, pending } = await useFetch<AuctionDetail | null>(
  `/api/auction/${platform}/${id}`,
  { default: () => null },
)

interface AuctionTranslationResponse {
  title: string | null
  description: string | null
  documentSummary: string | null
  extractionTexts: TranslatableExtractionTexts | null
}

interface LoadedAuctionTranslation {
  lang: ContentTargetLang
  sourceKey: string
  payload: AuctionTranslationResponse
}

function targetContentLang(value: string): ContentTargetLang | null {
  return value === 'de' || value === 'en' ? value : null
}

function hasTranslatableContent(val: AuctionDetail): boolean {
  return !(
    val.title == null &&
    val.description == null &&
    val.extraction?.documentSummary == null &&
    extractTranslatableExtractionTexts(val.extraction) == null
  )
}

function translationSourceKey(val: AuctionDetail): string {
  return JSON.stringify(translationContentSource(val))
}

function translationRequest(val: AuctionDetail | null, loc: string): { lang: ContentTargetLang, sourceKey: string } | null {
  if (!val || !hasTranslatableContent(val)) return null
  const lang = targetContentLang(loc)
  if (!lang || isPassthroughLanguage(val.country, lang)) return null
  return { lang, sourceKey: translationSourceKey(val) }
}

// Auto-translated title/description/document synthesis (WP-8): loaded silently whenever the
// viewer's locale differs from the auction's source language — unlike the
// original content, this replaces text the user would otherwise see
// untranslated. The cached translation is part of Nuxt async data so a page
// reload can hydrate an existing cache hit without flashing the source text.
const currentTranslationRequest = computed(() => translationRequest(a.value, locale.value))
const translationError = ref<string | null>(null)
const { data: loadedTranslation, pending: translationFetchPending } = await useAsyncData<LoadedAuctionTranslation | null>(
  `auction-translation:${platform}:${id}`,
  async () => {
    const request = currentTranslationRequest.value
    if (!request) return null
    try {
      const payload = await $fetch<AuctionTranslationResponse | null>(
        `/api/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/translation`,
        { method: 'POST', query: { lang: request.lang, cacheOnly: '1' } },
      )
      if (!payload) return null
      return { ...request, payload }
    } catch (err) {
      translationError.value = apiErrorMessage(err, t('objektDetail.translationError'))
      return null
    }
  },
  { default: () => null, watch: [currentTranslationRequest] },
)

const activeTranslation = computed(() => {
  const request = currentTranslationRequest.value
  const loaded = loadedTranslation.value
  if (!request || !loaded) return null
  return loaded.lang === request.lang && loaded.sourceKey === request.sourceKey ? loaded.payload : null
})

const translatedTitle = computed(() => activeTranslation.value?.title ?? null)
const translatedDescription = computed(() => activeTranslation.value?.description ?? null)
const translatedDocumentSummary = computed(() => activeTranslation.value?.documentSummary ?? null)
const translatedExtractionTexts = computed(() => activeTranslation.value?.extractionTexts ?? null)
const translationGenerationPending = ref(false)
const translationPending = computed(
  () => currentTranslationRequest.value != null && (translationFetchPending.value || translationGenerationPending.value),
)

const displayTitle = computed(() => translatedTitle.value ?? a.value?.title ?? null)
const displayDescription = computed(() => translatedDescription.value ?? a.value?.description ?? null)
const displayDocumentSummary = computed(
  () => translatedDocumentSummary.value ?? a.value?.extraction?.documentSummary ?? null,
)
const displayExtraction = computed(() => applyTranslatedExtractionTexts(a.value?.extraction, translatedExtractionTexts.value) ?? null)
const titleTranslated = computed(() => translatedTitle.value != null)
const descriptionTranslated = computed(
  () => translatedDescription.value != null || translatedDocumentSummary.value != null,
)
const sourceExtraction = computed(() => a.value?.extraction ?? null)
const auctionDataTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.biddingNotes)
const propertyDataTranslating = computed(
  () => translationPending.value && !!(sourceExtraction.value?.floor || sourceExtraction.value?.renovationNotes),
)
const amenitiesTranslating = computed(
  () => translationPending.value && !!(sourceExtraction.value?.heating || sourceExtraction.value?.insights?.construction),
)
const descriptionTranslating = computed(
  () => translationPending.value && !!(a.value?.description?.trim() || sourceExtraction.value?.documentSummary?.trim()),
)
const defectsTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.defects?.length)
const encumbrancesTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.encumbrances?.length)
const constructionTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.construction)
const locationCharacterTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.locationCharacter)
const planningNotesTranslating = computed(() => {
  const p = sourceExtraction.value?.planningNotes
  return translationPending.value && !!p && (
    p.monumentProtection != null ||
    p.contamination != null ||
    p.developmentPlan != null ||
    p.landConsolidation != null ||
    p.developmentCharges != null ||
    p.redevelopmentArea != null ||
    p.conservationArea != null
  )
})
const parcelsTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.planningNotes?.landParcels?.length)

const translationSeq = ref(0)
const TRANSLATION_PENDING_RETRY_MS = 2500
const TRANSLATION_PENDING_MAX_POLLS = 48

watch([currentTranslationRequest, activeTranslation, translationFetchPending], async ([request, existing, cacheLookupPending]) => {
  if (import.meta.server) return
  const seq = ++translationSeq.value
  translationGenerationPending.value = false
  if (!request || existing || cacheLookupPending) return

  translationGenerationPending.value = true
  translationError.value = null
  try {
    const payload = await fetchWithPendingRetry(
      () => $fetch<AuctionTranslationResponse>(
        `/api/auction/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/translation`,
        { method: 'POST', query: { lang: request.lang } },
      ),
      {
        maxPolls: TRANSLATION_PENDING_MAX_POLLS,
        retryMs: TRANSLATION_PENDING_RETRY_MS,
        shouldContinue: () => seq === translationSeq.value,
      },
    )
    if (!payload) return
    if (seq !== translationSeq.value) return
    loadedTranslation.value = { ...request, payload }
  } catch (err) {
    if (seq === translationSeq.value) {
      translationError.value = apiErrorMessage(err, t('objektDetail.translationError'))
    }
  } finally {
    if (seq === translationSeq.value) translationGenerationPending.value = false
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
  const e = displayExtraction.value
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
  // Large rural/land parcels can legitimately price out under 1 unit/m² —
  // rounding to 0 fraction digits then displays a real price as "0", which
  // reads as worthless rather than just cheap per square meter.
  const maximumFractionDigits = Math.abs(converted) < 1 ? 2 : 0
  return `${converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits })}/m²`
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
const locationContext = computed(() => a.value?.locationEnrichment?.locationContext ?? null)
const nearbyPlaces = computed(() => locationContext.value?.nearbyPlaces ?? [])
const locationMobility = computed(() => locationContext.value?.mobility ?? null)
const locationAmenities = computed(() => locationContext.value?.amenities ?? [])
const locationQuality = computed(() => locationContext.value?.quality ?? null)
const locationEnvironment = computed(() => locationContext.value?.environment ?? null)
// Written by the EEA noise enrichment but, until now, read by nothing.
const reportedNoise = computed(() => locationEnvironment.value?.reportedNoise ?? [])
const airQuality = computed(() => locationEnvironment.value?.airQuality ?? null)
const locationDemographics = computed(() => locationContext.value?.demographics ?? null)
const neighborhoodContext = computed(() => locationContext.value?.neighborhood ?? null)
const neighborhoodNotes = computed(() => neighborhoodContext.value?.notes ?? [])

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

function formatDistance(meters: number | null | undefined): string {
  if (meters == null) return '–'
  if (meters < 1000) return t('objektDetail.distanceMeters', { meters: meters.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 }) })
  return t('objektDetail.distanceKilometers', { kilometers: (meters / 1000).toLocaleString(intlLocale.value, { maximumFractionDigits: 1 }) })
}

function placeKindLabel(kind: NearbyPlaceKind): string {
  return t(`objektDetail.placeKind.${kind}`)
}

function publicTransportLevelLabel(level: LocationMobilityContext['publicTransportLevel']): string {
  return t(`objektDetail.publicTransportLevel.${level}`)
}

function roadAccessLevelLabel(level: LocationMobilityContext['roadAccessLevel']): string {
  return t(`objektDetail.roadAccessLevel.${level}`)
}

function settlementPatternLabel(pattern: NeighborhoodContext['settlementPattern']): string {
  return t(`objektDetail.settlementPatternLabel.${pattern}`)
}

function locationQualityLabel(verdict: string): string {
  return t(`objektDetail.locationQualityVerdict.${verdict}`)
}

function locationQualityClass(verdict: string): string {
  if (verdict === 'excellent' || verdict === 'good') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (verdict === 'average') return 'border-sky-200 bg-sky-50 text-sky-700'
  if (verdict === 'weak') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (verdict === 'isolated') return 'border-destructive/30 bg-destructive/10 text-destructive'
  return 'border-slate-200 bg-slate-50 text-slate-700'
}

function locationSignalLabel(code: string): string {
  const key = `objektDetail.locationSignal.${code}`
  const translated = t(key)
  return translated === key ? code : translated
}

function locationCaveatLabel(code: string): string {
  const key = `objektDetail.locationCaveat.${code}`
  const translated = t(key)
  return translated === key ? code : translated
}

function amenityKindLabel(kind: LocationAmenityKind): string {
  const key = `objektDetail.amenityKind.${kind}`
  const translated = t(key)
  return translated === key ? kind : translated
}

function noisyRoadLevelLabel(level: LocationEnvironmentContext['noisyRoadLevel']): string {
  return t(`objektDetail.noisyRoadLevel.${level}`)
}

function aviationNoiseLevelLabel(level: LocationEnvironmentContext['aviationNoiseLevel']): string {
  return t(`objektDetail.aviationNoiseLevel.${level}`)
}

/** "Strassenverkehr (Tag-Abend-Nacht)" — the source/indicator pair the EEA
 *  contour layer was read from. bandLabel carries the dB range itself. */
function noiseObservationLabel(observation: LocationNoiseObservation): string {
  return `${t(`objektDetail.noiseSource.${observation.source}`)} (${t(`objektDetail.noiseIndicator.${observation.indicator}`)})`
}

function airQualityLevelLabel(level: LocationAirQualityLevel): string {
  return t(`objektDetail.airQualityLevel.${level}`)
}

/** CAMS reports every pollutant in µg/m³. */
function formatConcentration(value: number): string {
  return `${value.toLocaleString(intlLocale.value, { maximumFractionDigits: 1 })} µg/m³`
}

function demographicSignalLabel(level: LocationDemographicContext['youthSignal']): string {
  return t(`objektDetail.demographicSignalLevel.${level}`)
}

function declineRiskLabel(level: LocationDemographicContext['declineRisk']): string {
  return t(`objektDetail.declineRiskLevel.${level}`)
}

function environmentSignalLabel(code: string): string {
  const key = `objektDetail.environmentSignal.${code}`
  const translated = t(key)
  return translated === key ? code : translated
}

function demographicReasonLabel(code: string): string {
  const key = `objektDetail.demographicReason.${code}`
  const translated = t(key)
  return translated === key ? code : translated
}

function demographicCaveatLabel(code: string): string {
  const key = `objektDetail.demographicCaveat.${code}`
  const translated = t(key)
  return translated === key ? code : translated
}

function neighborhoodNoteLabel(note: NeighborhoodContext['notes'][number] | string): string {
  if (typeof note === 'string') return note
  const key = `objektDetail.neighborhoodNote.${note.code}`
  const translated = t(key, note.params ?? {})
  return translated === key ? note.code : translated
}

function formatPopulation(place: NearbyPlace): string | null {
  if (place.population == null) return null
  return t('objektDetail.population', {
    count: place.population.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 }),
  })
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

// Flattened for the auction data files menu, which lists every attachment as a
// single row rather than grouping by kind — falls back to the kind label
// (e.g. "Gutachten") when an attachment has neither its own label nor filename.
const flatAttachments = computed(() => groupedAttachments.value.flatMap(
  (g) => g.items.map((att) => ({ att, groupLabel: g.label })),
))

// bg-zapori's attachment.proxyUrl is a signed upstream URL that expires —
// route through a redirect endpoint that fetches a fresh one on click instead
// of linking it directly (see server/api/bg-zapori-document).
function attachmentHref(att: Attachment): string | undefined {
  if (a.value?.platform === 'bg-zapori') {
    return `/api/bg-zapori-document/${a.value.externalId}/${att.fileId}`
  }
  return safeHref(att.proxyUrl)
}

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

const USAGE_IDEA_ICONS: Partial<Record<UsageIdeaType, Component>> = {
  'owner-occupation': Home,
  'owner-occupation-with-sublet': Layers3,
  'vacation-rental': Waves,
  farm: Tractor,
  agricultural: Sprout,
  forestry: TreePine,
  warehouse: Warehouse,
  other: Lightbulb,
}

const RENOVATION_COST_ICONS: Partial<Record<RenovationCostCategory, Component>> = {
  roof: Home,
  'facade-insulation': BrickWall,
  windows: Blinds,
  heating: Heater,
  electrical: Zap,
  'plumbing-bathroom': Bath,
  flooring: SquareStack,
  other: Wrench,
}

function formatCostRange(costMinEur: number, costMaxEur: number): string {
  const min = eurToDisplay(costMinEur)
  const max = eurToDisplay(costMaxEur)
  if (min == null || max == null) return '–'
  const fmt = (n: number) =>
    n.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
  return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`
}

const amenityItems = computed<AmenityItem[]>(() => {
  const e = displayExtraction.value
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
  const p = displayExtraction.value?.planningNotes
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

const defectItems = computed(() => displayExtraction.value?.insights?.defects ?? [])
const encumbranceItems = computed(() => displayExtraction.value?.insights?.encumbrances ?? [])
const landValueInsight = computed(() => displayExtraction.value?.insights?.landValueEurPerSqm ?? null)
const constructionInsight = computed(() => displayExtraction.value?.insights?.construction?.trim() ?? '')
const locationCharacterInsight = computed(() => displayExtraction.value?.insights?.locationCharacter?.trim() ?? '')
const landParcelItems = computed(() => displayExtraction.value?.planningNotes?.landParcels ?? [])

type AnalysisStatus = 'pending' | 'rules' | 'batch' | 'llm' | 'failed'

function hasCompletedLlmAnalysis(): boolean {
  return extractionHasCompletedLlmAnalysis(a.value?.extraction)
}

const analysisStatus = computed<AnalysisStatus>(() => {
  const e = a.value?.extraction
  if (!e) return 'pending'
  if (e.llmBatchJob) return 'batch'
  if (hasCompletedLlmAnalysis()) return 'llm'
  if ((e.llmFailures ?? 0) >= MAX_LLM_FAILURES) return 'failed'
  return 'rules'
})

const analysisStatusClass = computed(() => {
  if (analysisStatus.value === 'llm') return 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50'
  if (analysisStatus.value === 'batch') return 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-50'
  if (analysisStatus.value === 'rules') return 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-50'
  if (analysisStatus.value === 'failed') return 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/10'
  return 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-50'
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
          <Badge variant="outline" :class="analysisStatusClass">{{ $t(`objektDetail.analysisStatus.${analysisStatus}`) }}</Badge>
          <Badge v-if="a.cancelled" variant="destructive">{{ $t('objektDetail.cancelled') }}</Badge>
          <span class="font-mono text-muted-foreground">{{ a.caseNumber }}</span>
        </div>
        <div class="flex flex-wrap items-baseline gap-2">
          <h1 class="text-2xl font-bold leading-tight">{{ displayTitle || $t('objektDetail.untitled') }}</h1>
          <TranslationPendingBadge v-if="translationPending" />
          <span v-if="titleTranslated" class="text-xs text-muted-foreground">({{ $t('objektDetail.autoTranslatedHint') }})</span>
        </div>
        <p v-if="a.address" class="text-muted-foreground">{{ a.address }}</p>
        <p v-if="translationError" role="alert" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {{ translationError }}
        </p>
      </header>

      <AuctionPhotoGallery :photos="photoUrls" :alt-base="displayTitle || $t('objektDetail.fallbackTitle')" />

      <div class="space-y-8">
        <div class="space-y-8">
          <DetailSectionCard :title="$t('objektDetail.auctionDataTitle')">
            <template v-if="auctionDataTranslating" #action>
              <TranslationPendingBadge />
            </template>
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
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.versteigerungstermin') }}</dt>
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
              <div v-if="displayExtraction?.securityDeposit != null">
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.securityDeposit') }}</dt>
                <dd class="text-sm font-medium tabular-nums">{{ formatNative(displayExtraction.securityDeposit, a.currency) }}</dd>
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
                  <a
                    :href="googleCalendarUrl(calendarEvent)"
                    target="_blank"
                    rel="noopener"
                    class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                  >
                    <CalendarPlus class="h-4 w-4 text-muted-foreground" /> {{ $t('objektDetail.addToGoogleCalendar') }}
                  </a>
                  <a
                    :href="outlookCalendarUrl(calendarEvent)"
                    target="_blank"
                    rel="noopener"
                    class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                  >
                    <CalendarPlus class="h-4 w-4 text-muted-foreground" /> {{ $t('objektDetail.addToOutlookCalendar') }}
                  </a>
                  <a
                    :href="icsDataUrl(calendarEvent)"
                    :download="icsFilename(a.caseNumber)"
                    class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                  >
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
            <p
              v-if="displayExtraction?.source === 'llm'"
              class="mt-4 text-xs text-muted-foreground"
            >
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

          <LawyerContact :platform="a.platform" :external-id="a.externalId" :country="a.country" />

          <div class="space-y-6">
            <DetailSectionCard :title="$t('objektDetail.defectsTitle')">
              <template v-if="defectsTranslating" #action>
                <TranslationPendingBadge />
              </template>
              <ul v-if="defectItems.length" class="list-disc list-inside space-y-1 text-sm text-foreground/90">
                <li v-for="(defect, i) in defectItems" :key="i">{{ defect }}</li>
              </ul>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownDefects') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.encumbrancesTitle')">
              <template v-if="encumbrancesTranslating" #action>
                <TranslationPendingBadge />
              </template>
              <ul v-if="encumbranceItems.length" class="list-disc list-inside space-y-1 text-sm text-foreground/90">
                <li v-for="(encumbrance, i) in encumbranceItems" :key="i">{{ encumbrance }}</li>
              </ul>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownEncumbrances') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.landValueTitle')">
              <p v-if="landValueInsight != null" class="text-sm font-medium tabular-nums">{{ formatLandValue(landValueInsight) }}</p>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownLandValue') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.constructionTitle')">
              <template v-if="constructionTranslating" #action>
                <TranslationPendingBadge />
              </template>
              <p v-if="constructionInsight" class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{{ constructionInsight }}</p>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownConstruction') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.neighborhoodCharacter')">
              <template v-if="locationCharacterTranslating" #action>
                <TranslationPendingBadge />
              </template>
              <p v-if="locationCharacterInsight" class="whitespace-pre-line text-sm text-foreground/90 leading-relaxed">{{ locationCharacterInsight }}</p>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownLocationCharacter') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.planningNotesTitle')">
              <template v-if="planningNotesTranslating" #action>
                <TranslationPendingBadge />
              </template>
              <dl v-if="planningNotesHasContent" class="space-y-2 text-sm">
                <div v-if="displayExtraction?.planningNotes?.monumentProtection">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.monumentProtection') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.monumentProtection }}</dd>
                </div>
                <div v-if="displayExtraction?.planningNotes?.contamination">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.contamination') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.contamination }}</dd>
                </div>
                <div v-if="displayExtraction?.planningNotes?.developmentPlan">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.developmentPlan') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.developmentPlan }}</dd>
                </div>
                <div v-if="displayExtraction?.planningNotes?.landConsolidation">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.landConsolidation') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.landConsolidation }}</dd>
                </div>
                <div v-if="displayExtraction?.planningNotes?.developmentCharges">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.developmentCharges') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.developmentCharges }}</dd>
                </div>
                <div v-if="displayExtraction?.planningNotes?.redevelopmentArea">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.redevelopmentArea') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.redevelopmentArea }}</dd>
                </div>
                <div v-if="displayExtraction?.planningNotes?.conservationArea">
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.conservationArea') }}</dt>
                  <dd class="text-foreground/90">{{ displayExtraction.planningNotes.conservationArea }}</dd>
                </div>
              </dl>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownPlanningNotes') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.parcelsTitle')">
              <template v-if="parcelsTranslating" #action>
                <TranslationPendingBadge />
              </template>
              <ul v-if="landParcelItems.length" class="space-y-2 text-sm">
                <li v-for="(parcel, i) in landParcelItems" :key="i" class="flex items-baseline justify-between gap-3">
                  <span class="font-medium">{{ parcel.label }}</span>
                  <span class="text-foreground/90 text-right">
                    <span v-if="parcel.areaSqm != null" class="tabular-nums">{{ formatArea(parcel.areaSqm) }}</span>
                    <span v-if="parcel.use" class="block text-xs text-muted-foreground">{{ parcel.use }}</span>
                  </span>
                </li>
              </ul>
              <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noKnownParcels') }}</p>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.usageIdeasTitle')">
              <ul v-if="usageIdeas?.length" class="space-y-3 text-sm">
                <li v-for="(idea, i) in usageIdeas" :key="i" class="flex items-start gap-3">
                  <component :is="USAGE_IDEA_ICONS[idea.type] ?? Lightbulb" class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div class="min-w-0">
                    <p class="font-medium leading-snug">{{ usageIdeaTypeLabel(idea.type, idea.label) }}</p>
                    <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{{ idea.rationale }}</p>
                  </div>
                </li>
              </ul>
              <div v-else-if="usageIdeasError" class="flex items-center gap-2">
                <p class="text-sm text-destructive">{{ usageIdeasError }}</p>
                <Button type="button" size="sm" variant="outline" @click="generateUsageIdeas">
                  {{ $t('objektDetail.usageIdeasRetry') }}
                </Button>
              </div>
              <div
                v-else-if="usageIdeasPending"
                class="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
                <span>{{ $t('objektDetail.usageIdeasPending') }}</span>
              </div>
              <Button v-else type="button" size="sm" variant="outline" @click="generateUsageIdeas">
                {{ $t('objektDetail.usageIdeasGenerate') }}
              </Button>
            </DetailSectionCard>
            <DetailSectionCard :title="$t('objektDetail.renovationCostTitle')">
              <ul v-if="renovationCost?.length" class="space-y-3 text-sm">
                <li v-for="(item, i) in renovationCost" :key="i" class="flex items-start gap-3">
                  <component :is="RENOVATION_COST_ICONS[item.category] ?? Wrench" class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline justify-between gap-3">
                      <p class="font-medium leading-snug">{{ renovationCostCategoryLabel(item.category, item.label) }}</p>
                      <span class="shrink-0 text-xs font-medium tabular-nums text-foreground/90">
                        {{ formatCostRange(item.costMinEur, item.costMaxEur) }}
                      </span>
                    </div>
                    <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {{ item.rationale }}
                      <span v-if="item.confidence">
                        ({{ item.confidence === 'high' ? $t('objektDetail.confidenceHigh') : $t('objektDetail.confidenceLow') }})
                      </span>
                    </p>
                  </div>
                </li>
              </ul>
              <p v-else-if="renovationCost" class="text-sm text-muted-foreground">
                {{ $t('objektDetail.renovationCostEmpty') }}
              </p>
              <div v-else-if="renovationCostError" class="flex items-center gap-2">
                <p class="text-sm text-destructive">{{ renovationCostError }}</p>
                <Button type="button" size="sm" variant="outline" @click="generateRenovationCost">
                  {{ $t('objektDetail.renovationCostRetry') }}
                </Button>
              </div>
              <div
                v-else-if="renovationCostPending"
                class="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
                <span>{{ $t('objektDetail.renovationCostPending') }}</span>
              </div>
              <Button v-else type="button" size="sm" variant="outline" @click="generateRenovationCost">
                {{ $t('objektDetail.renovationCostGenerate') }}
              </Button>
            </DetailSectionCard>
          </div>
        </div>

        <CostCalculator v-if="a.country === 'de'" :market-value-eur="a.marketValueEur" :region="a.region" />

        <DetailSectionCard v-if="a.country === 'de'" :title="$t('objektDetail.safetyNoticeTitle')">
          <p class="text-base leading-relaxed text-foreground/85">{{ $t('objektDetail.safetyNoticeText') }}</p>
        </DetailSectionCard>
      </div>

      <section class="mt-8 space-y-5">
        <h2 class="text-2xl font-semibold tracking-tight">{{ $t('objektDetail.location') }}</h2>
        <template v-if="a.lat != null && a.lng != null">
          <AuctionDetailMap
            :lat="a.lat"
            :lng="a.lng"
            :label="a.address ?? undefined"
            :hazards="a.locationEnrichment?.hazards"
            :location-context="locationContext"
          />
          <div>
            <div v-if="locationContext" class="space-y-6">
            <DetailSectionCard v-if="locationQuality" :title="$t('objektDetail.locationQualityTitle')">
              <div class="space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="outline" :class="locationQualityClass(locationQuality.verdict)">
                    {{ locationQualityLabel(locationQuality.verdict) }}
                  </Badge>
                  <span class="text-sm font-semibold tabular-nums">{{ locationQuality.score }}/100</span>
                </div>
                <div v-if="locationQuality.strengths.length || locationQuality.weaknesses.length" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div v-if="locationQuality.strengths.length" class="rounded-md border bg-emerald-50/60 p-3">
                    <h3 class="text-xs font-semibold uppercase tracking-wide text-emerald-700">{{ $t('objektDetail.locationStrengths') }}</h3>
                    <ul class="mt-2 list-disc list-inside space-y-1 text-xs text-emerald-900">
                      <li v-for="(item, i) in locationQuality.strengths" :key="i">{{ locationSignalLabel(item) }}</li>
                    </ul>
                  </div>
                  <div v-if="locationQuality.weaknesses.length" class="rounded-md border bg-amber-50/60 p-3">
                    <h3 class="text-xs font-semibold uppercase tracking-wide text-amber-700">{{ $t('objektDetail.locationWeaknesses') }}</h3>
                    <ul class="mt-2 list-disc list-inside space-y-1 text-xs text-amber-900">
                      <li v-for="(item, i) in locationQuality.weaknesses" :key="i">{{ locationSignalLabel(item) }}</li>
                    </ul>
                  </div>
                </div>
              </div>
            </DetailSectionCard>

            <DetailSectionCard :title="$t('objektDetail.nearbyPlaces')">
              <div class="space-y-5">
              <div>
                <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearbyPlacesTitle') }}</h3>
                <ul v-if="nearbyPlaces.length" class="divide-y rounded-md border text-sm">
                  <li
                    v-for="place in nearbyPlaces"
                    :key="`${place.kind}:${place.name}:${place.distanceMeters}`"
                    class="flex items-start justify-between gap-3 px-3 py-2.5"
                  >
                    <span class="min-w-0">
                      <span class="block truncate font-medium">{{ place.name }}</span>
                      <span class="text-xs text-muted-foreground">
                        {{ placeKindLabel(place.kind) }}
                        <span v-if="formatPopulation(place)"> · {{ formatPopulation(place) }}</span>
                      </span>
                    </span>
                    <span class="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                      {{ formatDistance(place.distanceMeters) }}
                    </span>
                  </li>
                </ul>
                <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noNearbyPlaces') }}</p>
              </div>

              <div v-if="locationMobility" class="space-y-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.mobilityTitle') }}</h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.publicTransport') }}</dt>
                    <dd class="font-medium">{{ publicTransportLevelLabel(locationMobility.publicTransportLevel) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestStop') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationMobility.nearestStopDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.roadAccess') }}</dt>
                    <dd class="font-medium">{{ roadAccessLevelLabel(locationMobility.roadAccessLevel) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestMajorRoad') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationMobility.nearestMajorRoadDistanceMeters) }}</dd>
                  </div>
                  <div v-if="locationMobility.nearestRailStationDistanceMeters != null">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestRail') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationMobility.nearestRailStationDistanceMeters) }}</dd>
                  </div>
                  <div v-if="locationMobility.ferryAccessLikely">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.ferryAccess') }}</dt>
                    <dd class="font-medium">
                      {{ locationMobility.nearestFerryTerminalDistanceMeters != null ? formatDistance(locationMobility.nearestFerryTerminalDistanceMeters) : $t('objektDetail.ferryRouteNearby') }}
                    </dd>
                  </div>
                </dl>
                <p class="text-xs text-muted-foreground">
                  {{ $t('objektDetail.publicTransportStops', { near: locationMobility.stopCountWithin1000m, wider: locationMobility.stopCountWithin3000m }) }}
                </p>
              </div>
              </div>
            </DetailSectionCard>

            <DetailSectionCard v-if="locationEnvironment" :title="$t('objektDetail.environmentTitle')">
              <div class="space-y-3">
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.noisyRoads') }}</dt>
                    <dd class="font-medium">{{ noisyRoadLevelLabel(locationEnvironment.noisyRoadLevel) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.aviationNoise') }}</dt>
                    <dd class="font-medium">{{ aviationNoiseLevelLabel(locationEnvironment.aviationNoiseLevel) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestMotorway') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestMotorwayDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestAirport') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestAirportDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestRunway') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestRunwayDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestHelipad') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestHelipadDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestIndustrial') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestIndustrialDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestHeavyIndustry') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestHeavyIndustryDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.commercialAreas') }}</dt>
                    <dd class="font-medium tabular-nums">{{ locationEnvironment.commercialCountWithin3000m.toLocaleString(intlLocale) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.industrialAreas') }}</dt>
                    <dd class="font-medium tabular-nums">{{ locationEnvironment.industrialCountWithin3000m.toLocaleString(intlLocale) }}</dd>
                  </div>
                </dl>
                <div v-if="reportedNoise.length" class="space-y-2">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {{ $t('objektDetail.reportedNoiseTitle') }}
                  </h3>
                  <ul class="divide-y rounded-md border text-sm">
                    <li
                      v-for="observation in reportedNoise"
                      :key="`${observation.source}-${observation.indicator}`"
                      class="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span>{{ noiseObservationLabel(observation) }}</span>
                      <span class="shrink-0 font-medium tabular-nums">{{ observation.bandLabel }}</span>
                    </li>
                  </ul>
                  <p class="text-xs text-muted-foreground">
                    {{ $t('objektDetail.reportedNoiseHint') }}
                  </p>
                </div>
                <div v-if="airQuality" class="space-y-2">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {{ $t('objektDetail.airQualityTitle') }}
                  </h3>
                  <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <div>
                      <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityIndex') }}</dt>
                      <dd class="font-medium">
                        {{ airQualityLevelLabel(airQuality.level) }}
                        <span v-if="airQuality.index != null" class="tabular-nums text-muted-foreground">({{ airQuality.index }})</span>
                      </dd>
                    </div>
                    <div v-if="airQuality.particulateMatter25 != null">
                      <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityPm25') }}</dt>
                      <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.particulateMatter25) }}</dd>
                    </div>
                    <div v-if="airQuality.particulateMatter10 != null">
                      <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityPm10') }}</dt>
                      <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.particulateMatter10) }}</dd>
                    </div>
                    <div v-if="airQuality.nitrogenDioxide != null">
                      <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityNo2') }}</dt>
                      <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.nitrogenDioxide) }}</dd>
                    </div>
                    <div v-if="airQuality.ozone != null">
                      <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityOzone') }}</dt>
                      <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.ozone) }}</dd>
                    </div>
                  </dl>
                  <p class="text-xs text-muted-foreground">{{ $t('objektDetail.airQualityHint') }}</p>
                </div>
                <ul v-if="locationEnvironment.riskSignals.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                  <li v-for="(item, i) in locationEnvironment.riskSignals" :key="i">{{ environmentSignalLabel(item) }}</li>
                </ul>
              </div>
            </DetailSectionCard>

            <DetailSectionCard v-if="locationDemographics" :title="$t('objektDetail.demographicsTitle')">
              <div class="space-y-3">
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.youthSignal') }}</dt>
                    <dd class="font-medium">{{ demographicSignalLabel(locationDemographics.youthSignal) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.employmentSignal') }}</dt>
                    <dd class="font-medium">{{ demographicSignalLabel(locationDemographics.employmentSignal) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.declineRisk') }}</dt>
                    <dd class="font-medium">{{ declineRiskLabel(locationDemographics.declineRisk) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.universityDistance') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationDemographics.universityDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.schoolsChildcare') }}</dt>
                    <dd class="font-medium tabular-nums">{{ locationDemographics.schoolOrChildcareCountWithin3000m.toLocaleString(intlLocale) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.workplaceSignals') }}</dt>
                    <dd class="font-medium tabular-nums">{{ locationDemographics.workplaceSignalCountWithin5000m.toLocaleString(intlLocale) }}</dd>
                  </div>
                </dl>
                <ul v-if="locationDemographics.reasons.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                  <li v-for="(item, i) in locationDemographics.reasons" :key="i">{{ demographicReasonLabel(item) }}</li>
                </ul>
              </div>
            </DetailSectionCard>

            <DetailSectionCard v-if="locationAmenities.length || neighborhoodContext" :title="$t('objektDetail.dailyNeedsNeighborhoodTitle')">
              <div class="space-y-5">
              <div v-if="locationAmenities.length" class="space-y-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.dailyNeedsTitle') }}</h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div v-for="item in locationAmenities" :key="item.kind">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ amenityKindLabel(item.kind) }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(item.nearestDistanceMeters) }}</dd>
                    <dd class="text-xs text-muted-foreground">{{ $t('objektDetail.amenityCounts', { near: item.countWithin1000m, wider: item.countWithin5000m }) }}</dd>
                  </div>
                </dl>
              </div>

              <div v-if="neighborhoodContext" class="space-y-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.neighborhoodSignalsTitle') }}</h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.settlementPattern') }}</dt>
                    <dd class="font-medium">{{ settlementPatternLabel(neighborhoodContext.settlementPattern) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.buildingDensity') }}</dt>
                    <dd class="font-medium tabular-nums">
                      {{ neighborhoodContext.buildingDensityPerSqKm == null ? '–' : neighborhoodContext.buildingDensityPerSqKm.toLocaleString(intlLocale, { maximumFractionDigits: 0 }) }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.amenitiesNearby') }}</dt>
                    <dd class="font-medium tabular-nums">{{ neighborhoodContext.amenityCountWithin1000m.toLocaleString(intlLocale) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.vacantSignals') }}</dt>
                    <dd class="font-medium tabular-nums">{{ neighborhoodContext.vacantOrRuinCountWithin500m.toLocaleString(intlLocale) }}</dd>
                  </div>
                </dl>
                <ul v-if="neighborhoodNotes.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                  <li v-for="(item, i) in neighborhoodNotes" :key="i">{{ neighborhoodNoteLabel(item) }}</li>
                </ul>
              </div>
              </div>
            </DetailSectionCard>

            <DetailSectionCard :title="$t('objektDetail.locationSourceTitle')">
              <div class="space-y-3">
              <p class="text-xs text-muted-foreground">
                {{ $t('objektDetail.sourceChecked', { source: locationContext.source.label, date: formatShortDate(locationContext.checkedAt) }) }}
                <a :href="safeHref(locationContext.source.url)" target="_blank" rel="noopener" class="ml-1 underline underline-offset-2 hover:text-foreground">
                  {{ $t('objektDetail.sourceLink') }}
                </a>
              </p>
              <ul v-if="locationQuality?.caveats.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li v-for="(item, i) in locationQuality.caveats" :key="i">{{ locationCaveatLabel(item) }}</li>
              </ul>
              <ul v-if="locationDemographics?.caveats.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li v-for="(item, i) in locationDemographics.caveats" :key="i">{{ demographicCaveatLabel(item) }}</li>
              </ul>
              <p class="text-xs text-muted-foreground">{{ $t('objektDetail.locationContextDisclaimer') }}</p>
              </div>
            </DetailSectionCard>
          </div>
            <DetailSectionCard v-else :title="$t('objektDetail.nearbyPlaces')">
              <p class="text-sm text-muted-foreground">{{ $t('objektDetail.noExternalLocationContext') }}</p>
            </DetailSectionCard>
          </div>
        </template>
        <DetailSectionCard v-else :title="$t('objektDetail.nearbyPlaces')">
          <p class="text-sm text-muted-foreground">{{ $t('objektDetail.noExternalLocationContext') }}</p>
        </DetailSectionCard>
      </section>

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
