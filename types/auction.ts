import type { PropertyType } from '~/lib/property-type'
import type { Condition } from '~/lib/condition'
import type { Feature } from '~/lib/features'

export interface DataSourceAttribution {
  id: string
  label: string
  url: string
  licenseNote: string
}

export type MarketComparisonPropertyClass = 'house' | 'apartment' | 'land' | 'mixed' | 'unknown'

export interface MarketComparison {
  pricePerSqm: number | null
  basis: 'livingArea' | 'landArea'
  areaSqm: number
  regionLabel: string
  propertyClass: MarketComparisonPropertyClass
  medianPricePerSqm: number | null
  p25PricePerSqm: number | null
  p75PricePerSqm: number | null
  deltaPctVsMedian: number | null
  verdict: 'cheaper' | 'similar' | 'more_expensive' | 'insufficient_data'
  samples: number
  sources: DataSourceAttribution[]
}

export interface LandValueBaseline {
  valueEurPerSqm: number
  regionLabel: string
  zoneLabel: string | null
  distanceMeters: number | null
  source: DataSourceAttribution
  checkedAt: string
}

export type HazardKind =
  | 'flood'
  | 'wildfire'
  | 'avalanche'
  | 'earthquake'
  | 'landslide'
  | 'storm'
  | 'hail'
  | 'snow_load'

export interface HazardAssessment {
  hazard: HazardKind
  status: 'inside' | 'nearby' | 'outside' | 'unknown'
  severity: 'low' | 'medium' | 'high' | 'very_high' | 'unknown'
  distanceMeters: number | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
  stale?: boolean
}

export type NearbyPlaceKind =
  | 'city'
  | 'town'
  | 'suburb'
  | 'village'
  | 'hamlet'
  | 'island'
  | 'municipality'
  | 'unknown'

export interface NearbyPlace {
  name: string
  kind: NearbyPlaceKind
  distanceMeters: number
  population: number | null
}

export interface LocationMobilityContext {
  publicTransportLevel: 'none' | 'limited' | 'good' | 'excellent' | 'unknown'
  nearestStopDistanceMeters: number | null
  stopCountWithin1000m: number
  stopCountWithin3000m: number
  nearestRailStationDistanceMeters: number | null
  roadAccessLevel: 'remote' | 'local' | 'regional' | 'major' | 'unknown'
  nearestMajorRoadDistanceMeters: number | null
  majorRoadKinds: string[]
  nearestFerryTerminalDistanceMeters: number | null
  hasFerryRouteNearby: boolean
  ferryAccessLikely: boolean
}

export type LocationAmenityKind =
  | 'groceries'
  | 'education'
  | 'healthcare'
  | 'hospital'
  | 'pharmacy'
  | 'banking'
  | 'fuel'
  | 'food'
  | 'restaurant'
  | 'cafe'
  | 'leisure'
  | 'recreation'

export interface LocationAmenitySummary {
  kind: LocationAmenityKind
  nearestDistanceMeters: number | null
  countWithin1000m: number
  countWithin3000m: number
  countWithin5000m: number
}

export type LocationMapFeatureKind =
  | 'groceries'
  | 'pharmacy'
  | 'healthcare'
  | 'hospital'
  | 'school'
  | 'childcare'
  | 'public_transport'
  | 'rail'
  | 'university'
  | 'industry'
  | 'commercial'
  | 'major_road'
  | 'airport'
  | 'runway'
  | 'helipad'
  | 'ferry'
  | 'restaurant'
  | 'cafe'
  | 'recreation'
  | 'leisure'

export interface LocationMapFeature {
  kind: LocationMapFeatureKind
  name: string | null
  lat: number
  lng: number
  distanceMeters: number
  osmType: 'node' | 'way' | 'relation'
  osmId: number
}

export interface LocationEnvironmentContext {
  industrialCountWithin1000m: number
  industrialCountWithin3000m: number
  commercialCountWithin1000m: number
  commercialCountWithin3000m: number
  nearestIndustrialDistanceMeters: number | null
  nearestCommercialDistanceMeters: number | null
  nearestHeavyIndustryDistanceMeters: number | null
  heavyIndustryKinds: string[]
  heavyIndustrySites: { kind: string; name: string | null; distanceMeters: number }[]
  noisyRoadLevel: 'low' | 'medium' | 'high' | 'unknown'
  aviationNoiseLevel: 'low' | 'medium' | 'high' | 'unknown'
  nearestMotorwayDistanceMeters: number | null
  nearestPrimaryRoadDistanceMeters: number | null
  nearestAirportDistanceMeters: number | null
  nearestRunwayDistanceMeters: number | null
  nearestHelipadDistanceMeters: number | null
  nearestAirportName: string | null
  nearestAirportKind: 'major' | 'regional' | 'minor' | 'military' | 'unknown'
  reportedNoise?: LocationNoiseObservation[]
  airQuality?: LocationAirQualityObservation | null
  climateNormals?: LocationClimateNormals | null
  riskSignals: string[]
}

/** European Air Quality Index bands, as published by the EEA. */
export type LocationAirQualityLevel =
  | 'good'
  | 'fair'
  | 'moderate'
  | 'poor'
  | 'very_poor'
  | 'extremely_poor'
  | 'unknown'

export interface LocationAirQualityObservation {
  /** European AQI value; null when the grid has no value for this point. */
  index: number | null
  level: LocationAirQualityLevel
  particulateMatter10: number | null
  particulateMatter25: number | null
  nitrogenDioxide: number | null
  ozone: number | null
  /** Timestamp of the modelled hour the values describe. */
  observedAt: string | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export interface LocationClimateMonthNormal {
  /** 1 = January … 12 = December. */
  month: number
  /** Average daily maximum temperature (°C) over the reference period. */
  tempMaxAvgC: number
  /** Average daily mean temperature (°C) over the reference period. */
  tempMeanAvgC: number
  /** Average daily minimum ("night") temperature (°C) over the reference period. */
  tempMinAvgC: number
  /** Average monthly precipitation total (mm) over the reference period. */
  precipitationAvgMm: number
}

export interface LocationClimateNormals {
  periodStartYear: number
  periodEndYear: number
  /** Twelve entries, ordered January (1) through December (12). */
  months: LocationClimateMonthNormal[]
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export type LocationNoiseSource = 'road' | 'rail' | 'aviation' | 'industry'
export type LocationNoiseIndicator = 'lden' | 'lnight'

export interface LocationNoiseObservation {
  source: LocationNoiseSource
  indicator: LocationNoiseIndicator
  level: 'low' | 'medium' | 'high' | 'unknown'
  bandLabel: string
  minDb: number | null
  maxDb: number | null
  value: number
  sourceLayerName: string | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export interface LocationDemographicContext {
  youthSignal: 'low' | 'medium' | 'high' | 'unknown'
  employmentSignal: 'low' | 'medium' | 'high' | 'unknown'
  declineRisk: 'low' | 'medium' | 'high' | 'unknown'
  universityDistanceMeters: number | null
  schoolOrChildcareCountWithin3000m: number
  workplaceSignalCountWithin5000m: number
  reasons: string[]
  caveats: string[]
}

export interface LocationContextNote {
  code: string
  params?: Record<string, number | string>
}

export interface NeighborhoodContext {
  settlementPattern: 'urban' | 'suburban' | 'town' | 'village' | 'rural' | 'remote' | 'island' | 'unknown'
  buildingCountWithin500m: number
  buildingDensityPerSqKm: number | null
  amenityCountWithin1000m: number
  vacantOrRuinCountWithin500m: number
  notes: LocationContextNote[]
}

export interface LocationQualityAssessment {
  score: number
  verdict: 'excellent' | 'good' | 'average' | 'weak' | 'isolated' | 'unknown'
  strengths: string[]
  weaknesses: string[]
  caveats: string[]
}

export interface LocationContext {
  nearbyPlaces: NearbyPlace[]
  mobility: LocationMobilityContext
  amenities: LocationAmenitySummary[]
  environment: LocationEnvironmentContext
  demographics: LocationDemographicContext
  mapFeatures: LocationMapFeature[]
  neighborhood: NeighborhoodContext
  quality: LocationQualityAssessment
  source: DataSourceAttribution
  checkedAt: string
}

export interface LocationEnrichment {
  platform: string
  externalId: string
  lat: number
  lng: number
  marketComparison?: MarketComparison | null
  landValueBaseline?: LandValueBaseline | null
  hazards?: HazardAssessment[] | null
  locationContext?: LocationContext | null
  checkedAt: string
  sourceVersion: string
}

export type AttachmentKind = 'announcement' | 'photo' | 'brochure' | 'appraisal' | 'other'

export interface Attachment {
  kind: AttachmentKind
  label: string
  filename: string
  sizeBytes: number | null
  fileId: string
  /** URL the app fetches the file from: either a local proxy path (platforms
   *  whose upstream requires a specific Referer) or the
   *  direct upstream URL when the file is publicly fetchable without one. */
  proxyUrl: string
}

export interface Auction {
  /** Which crawler produced this auction (matches PlatformCrawler.id). */
  platform: string
  /** ISO 3166-1 alpha-2 country code, lowercase ('de', 'es', 'at', 'it', 'cz', 'pl'). */
  country: string
  /** Human-readable region name within the country (e.g. 'Sachsen', 'Madrid').
   *  Empty string when the source platform does not expose sub-regions. */
  region: string
  /** Stable per-platform id for the auction (native identifier in the source
   *  platform; non-DE crawlers fill it with their own native identifier). */
  externalId: string
  caseNumber: string
  authority: string
  title: string | null
  address: string | null
  /** Original value in `currency` — source of truth for non-EUR platforms.
   *  Absent/null for EUR-native crawlers, which keep assigning
   *  `marketValueEur` directly; `deriveMarketValueEur`
   *  (server/utils/exchange-rate.ts) backfills this field from it. */
  marketValue?: number | null
  /** ISO 4217 code of `marketValue` ('GBP', 'HUF', 'CZK', ...). Absent/null
   *  for EUR-native crawlers. */
  currency?: string | null
  /** Derived: `marketValue` converted to EUR via `deriveMarketValueEur`
   *  (server/utils/exchange-rate.ts), which every crawl/enrich run applies
   *  after the crawler/enrichOne sets `marketValue`+`currency`. Kept as the
   *  cross-country sort/filter field (priceMin/priceMax). */
  marketValueEur: number | null
  marketValueText: string | null
  /** Opening/reserve bid for online-bidding-style platforms (Biddit, si, fi,
   *  hu, pl, boe, ca, us-bid4assets) — the price bidding starts at, which
   *  typically doubles as the reserve. Native value in `currency` (same
   *  currency as `marketValue`). Absent for German-court-style platforms
   *  (zvg-portal, at, ...), where the legally binding minimum ("geringstes
   *  Gebot") is only determined live at the in-person Termin from liens
   *  registered by then and is never pre-published. */
  startingBid?: number | null
  /** Live current highest bid during an active online bidding period —
   *  genuinely time-varying (unlike startingBid/marketValue, which are set
   *  once), refreshed on every crawl. Only a couple of platforms (Biddit,
   *  fi) expose this. */
  currentBid?: number | null
  /** Security deposit the platform states directly as a structured field
   *  (e.g. si's Kaution) — native value in `currency`. Distinct from
   *  `AuctionExtraction.securityDeposit`, which is rules/LLM-extracted from
   *  free text (the German case: the standard 10%-of-Verkehrswert rule is
   *  implicit and unpublished, only an explicit court deviation is worth
   *  extracting). enrich.ts merges both into `extraction.securityDeposit`,
   *  preferring this structured value — same convention as
   *  `sourceLivingAreaSqm` below. */
  sourceSecurityDeposit?: number | null
  auctionDateIso: string | null
  auctionDateText: string | null
  cancelled: boolean
  sourceUpdatedIso: string | null
  /** Local proxy URL — direct upstream links may require a platform-specific Referer. */
  pdfUrl: string | null
  /** Local proxy URL for the upstream Detailansicht. Null when the platform
   *  has no lot-specific detail page for this auction. */
  detailUrl: string | null
  /** Original upstream URL for the PDF (for reference). */
  pdfUrlUpstream: string | null
  /** Original upstream URL for the detail page (for reference). Null when the platform
   *  has no lot-specific detail page (enrichment is skipped for these lots). */
  detailUrlUpstream: string | null
  /** All attachments scraped from the Detailansicht page. */
  attachments: Attachment[]
  /** Free-text description scraped from the detail page (Beschreibung field). */
  description: string | null
  /** Number of photos available (counted from Foto attachments and embedded JPEGs). */
  photoCount: number
  /** Local URL for a JPEG thumbnail of the first photo, if any. */
  thumbnailUrl: string | null
  /** Structured values provided directly by the source platform (JSON field,
   *  key/value table on the detail page). The enrich task prefers these over
   *  text/PDF extraction — set them whenever the upstream exposes them. */
  sourceLivingAreaSqm?: number | null
  sourceLandAreaSqm?: number | null
  sourceRooms?: number | null
  /** Direct upstream image URLs (the full gallery, not just the thumbnail).
   *  Mirrored into the local image cache by the enrich task for storage and
   *  content-hash dedupe against document-extracted photos. Crawlers setting
   *  this should also set `photoCount` accordingly. */
  photoUrls?: string[]
  /** Coordinates provided by the source platform — spares a geocoder lookup.
   *  Overlaid as-is by /api/auctions-geo. */
  lat?: number | null
  lng?: number | null
  /** ISO timestamp of the last successful (non-throwing) `enrichOne` call.
   *  Absent on the fresh listing crawl and persisted in auction_fetch_state.
   *  Used by the enrich task to distinguish
   *  "detail never fetched" from "fetched, and the listing legitimately has no
   *  attachments/description" — the latter would otherwise be retried on every
   *  run. */
  detailFetchedAt?: string | null
  /** Structured fields extracted from listing text and archived documents.
   *  Absent at crawl time and reconstructed from auction_details on reads. */
  extraction?: AuctionExtraction | null
  /** Mutable processing state, kept separate from versioned extraction facts. */
  processing?: {
    llmBatchJob: string | null
    llmFailures: number
    /** Fresh (within LLM_CLAIM_LEASE_MS) means a sync LLM call is currently
     *  in flight for this auction — see writeAuctionLlmClaim. */
    llmClaimedAt: string | null
    photosCheckedAt: string | null
    photoFailures: number
    photoPipelineVersion: number | null
  } | null
}

/** Coarse bucket a curated photo falls into. Drives frontend
 *  sorting/grouping only — it never filters a photo out. */
export type PhotoCategory = 'aussen' | 'innen' | 'grundriss' | 'lageplan' | 'sonstiges'

/** A single curated photo stored with its auction_details version. */
export interface CuratedPhoto {
  /** Filename relative to `.cache_zvg/images/<platform>/<externalId>/`,
   *  served via /api/auction-image. */
  file: string
  category: PhotoCategory
  caption: string | null
  /** Whether this depicts the property itself (vs. a Grundriss/Lageplan).
   *  Metadata only — all curated photos are kept regardless; this drives
   *  frontend sorting/grouping, it does not filter. */
  isPropertyPhoto: boolean
  /** Eignung als erstes Bild der Auktion von 0 bis 100. Fehlend bei älteren,
   * noch nicht visuell kuratierten Bildern. */
  appealScore?: number
}

/** Richer LLM-only assessment pulled from the Gutachten/Exposé — the "why is
 *  this listing interesting/risky" layer beyond the plain size/type facts. */
export interface AuctionInsights {
  /** Defects / damage / renovation backlog called out in the appraisal. */
  defects: string[]
  /** Encumbrances (Wohnrecht, Nießbrauch, Dienstbarkeiten, ...). */
  encumbrances: string[]
  /** Bodenrichtwert in EUR/m², or null. */
  landValueEurPerSqm: number | null
  /** Bauweise/Konstruktion, or null. */
  construction: string | null
  /** Lagecharakter, or null. */
  locationCharacter: string | null
  /** Short overall assessment, or null. */
  summary: string | null
}

/** One Teilfläche/Flurstück from the Gutachten's "wertmethodische Aufteilung
 *  des Grundstückes" section, or a single Flurstück row from its "Aufteilung
 *  auf die Flurstücke" table. */
export interface LandParcel {
  /** Label as given in the Gutachten (e.g. "Teilfläche A" or a Flurstücksnummer like "743/1"). */
  label: string
  areaSqm: number | null
  /** Nutzung/Zweck (e.g. "gewerbliche Baufläche", "öffentliche Verkehrsfläche"), or null. */
  use: string | null
}

/** LLM-only planning/legal notes from the Gutachten's "weitere
 *  Zustandsmerkmale" table (Denkmalschutz, Altlasten, Bauleitplanung, ...) —
 *  a sibling to `AuctionInsights`, kept separate since these are per-topic
 *  short facts rather than a free-form assessment. */
export interface PlanningNotes {
  /** Denkmalschutz-Detail (O-Ton, e.g. "kein Denkmalschutz gemäß
   *  Denkmalliste"), or null. Complements the binary `features: 'denkmalschutz'` flag. */
  monumentProtection: string | null
  /** Altlasten-Hinweis, or null. */
  contamination: string | null
  /** Bauleitplanung/B-Plan-Festsetzung, or null. */
  developmentPlan: string | null
  /** Bodenordnung, or null. */
  landConsolidation: string | null
  /** Erschließungs-/Ausbaubeiträge, or null. */
  developmentCharges: string | null
  /** Sanierungsgebiet, or null. */
  redevelopmentArea: string | null
  /** Erhaltungsgebiet, or null. */
  conservationArea: string | null
  /** Aufteilung des Grundstücks in Teilflächen/Flurstücke mit Fläche und Nutzung. */
  landParcels: LandParcel[]
}

/** The "extracted layer": property type + sizes derived by the enrich task's
 *  rules pass (and later the LLM fallback). */
export interface AuctionExtraction {
  propertyType: PropertyType | null
  /** Grundstücksfläche in m². */
  landAreaSqm: number | null
  /** Wohnfläche in m² (kept separate from land area). */
  livingAreaSqm: number | null
  rooms: number | null
  /** Schlafzimmeranzahl, soweit im Gutachten/Exposé explizit genannt. */
  bedrooms?: number | null
  /** Badezimmeranzahl, soweit im Gutachten/Exposé explizit genannt. */
  bathrooms?: number | null
  /** Etage/Geschosslage bei Wohnungen, als kurzer Original-/Normaltext
   *  ("EG", "1. OG", "Dachgeschoss", ...), oder null. */
  floor?: string | null
  /** Ausstattung des Badezimmers, soweit ausdrücklich genannt. */
  bathroomHasTub?: boolean | null
  bathroomHasShower?: boolean | null
  /** Heizungsart/Energieträger als kurzer Freitext (z. B. "Gaszentralheizung",
   *  "Wärmepumpe", "Ofenheizung"), oder null. */
  heating?: string | null
  /** Number of Wohneinheiten. */
  units: number | null
  /** Merged security-deposit figure, in the auction's `currency`:
   *  `Auction.sourceSecurityDeposit` when the platform states it directly,
   *  else rules/LLM-extracted from free text (only ever set there for an
   *  explicit deviation from a country's statutory default — e.g. German
   *  Sicherheitsleistung is 10% of Verkehrswert by law and unpublished
   *  unless a court deviates from it). */
  securityDeposit?: number | null
  /** LLM-only free text for anything unusual about the bidding process the
   *  announcement calls out (a deviating security-deposit rule, an atypical
   *  payment deadline, ...) — null when nothing stood out. */
  biddingNotes?: string | null
  /** LLM-only field (no rules source). `undefined` = never checked yet (older
   *  cache entries, or a run that hit the LLM cap before reaching this
   *  listing); `null` = checked, nothing found. Distinguishing the two lets
   *  enrich.ts backfill it once without re-checking forever. */
  condition?: Condition | null
  /** LLM-only field. `undefined` = never checked yet; `[]` = checked, no
   *  features found. Same backfill semantics as `condition`. */
  features?: Feature[]
  source: 'rules' | 'llm'
  confidence: 'high' | 'low'
  /** LLM-only. `undefined` = never checked yet; `null` = checked, nothing
   *  found. Same backfill semantics as `condition`. */
  yearBuilt?: number | null
  /** LLM-only. `undefined` = never checked yet; `null` = checked, nothing
   *  found. Same backfill semantics as `condition`. */
  lastRenovationYear?: number | null
  /** LLM-only free text on any renovation/modernisation, or null. */
  renovationNotes?: string | null
  /** LLM-only richer assessment. `undefined` = never checked yet; `null` =
   *  checked, nothing found. Same backfill semantics as `condition`. */
  insights?: AuctionInsights | null
  /** LLM-only planning/legal notes (Denkmalschutz, Altlasten, Bauleitplanung,
   *  Grundstücksaufteilung, ...). `undefined` = never checked yet; `null` =
   *  checked, nothing found. Same backfill semantics as `condition`. */
  planningNotes?: PlanningNotes | null
  /** Detailed, factual synthesis of all listing-specific documents supplied
   * to the extractor. Shown as part of the normal description rather than as
   * a separate on-demand "AI summary". `undefined` means an older cache entry
   * has not been backfilled yet; `null` means the documents contained no
   * useful additional description. */
  documentSummary?: string | null
  /** LLM-only Verkehrswert extracted from the Gutachten text, in the
   *  auction's `currency`. `undefined` = never checked yet; `null` = checked,
   *  nothing found. Same backfill semantics as `condition`. Only ever applied
   *  to `Auction.marketValueEur` when that field isn't already set from a
   *  structural source (AT-Edikte/Biddit's Verkehrswert-Cache — see
   *  enrich.ts/auction-extraction.ts) — a platform with a known-reliable value
   *  is never overwritten by an LLM guess. */
  marketValueEur?: number | null
  /** LLM-only free-text O-Ton for `marketValueEur` (e.g. "185.000 EUR laut
   *  Gutachten"), or null. */
  marketValueText?: string | null
  /** Curated photos in display order. Empty/absent when the listing or
   *  archived documents held no usable photos. Served via /api/auction-image. */
  photos?: CuratedPhoto[]
  /** ISO timestamp of when this extraction was produced. */
  at: string
  /** ISO timestamp of the last successful LLM analysis. Rules-only interim
   *  entries leave this unset, even when they already contain useful source or
   *  regex-derived fields. */
  llmAnalyzedAt?: string
}

export interface CrawlResult {
  /** Platform id (matches PlatformCrawler.id). */
  platform: string
  source: string
  /** ISO 3166-1 alpha-2 country code(s) covered by this result. */
  countries: string[]
  /** Region names covered by this result. Empty array means "alle". */
  regions: string[]
  fetchedAt: string
  /** Platform ids that actually delivered this result. Normally just
   *  `[platform]`; crawlSingle merges every platform covering a region and
   *  drops the ones that threw, so this is the only way to tell a platform
   *  that legitimately returned nothing from one that failed. Auction expiry
   *  depends on that distinction — see server/utils/crawl-state.ts. */
  platformsSucceeded: string[]
  /** Total reported by the upstream platform; null when unknown or aggregated. */
  totalReported: number | null
  auctions: Auction[]
}
