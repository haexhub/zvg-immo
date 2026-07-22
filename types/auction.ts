import type { PropertyType } from '~/lib/property-type'
import type { Condition } from '~/lib/condition'
import type { Feature } from '~/lib/features'

export type AttachmentKind = 'announcement' | 'photo' | 'brochure' | 'appraisal' | 'other'

export interface Attachment {
  kind: AttachmentKind
  label: string
  filename: string
  sizeBytes: number | null
  fileId: string
  /** URL the app fetches the file from: either a local proxy path (platforms
   *  whose upstream requires a specific Referer, e.g. /api/zvg-proxy?…) or the
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
   *  Mirrored into the local image cache by the enrich task, which turns them
   *  into `extraction.photos`. Crawlers setting this should also set
   *  `photoCount` accordingly. */
  photoUrls?: string[]
  /** Coordinates provided by the source platform — spares a geocoder lookup.
   *  Overlaid as-is by /api/auctions-geo. */
  lat?: number | null
  lng?: number | null
  /** ISO timestamp of the last successful (non-throwing) `enrichOne` call.
   *  Absent on the fresh listing crawl; set on the auction-snapshot side and
   *  preserved across snapshot merges. Used by the enrich task to distinguish
   *  "detail never fetched" from "fetched, and the listing legitimately has no
   *  attachments/description" — the latter would otherwise be retried on every
   *  run. */
  detailFetchedAt?: string | null
  /** Structured fields extracted from the listing text/documents. Always absent
   *  at crawl time — populated read-only from the extraction cache by the
   *  /api/auctions overlay (mirrors how marketValueEur is filled). */
  extraction?: AuctionExtraction | null
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
  /** How many times an LLM extraction was attempted for this listing and the
   *  request itself failed (not "ran and returned empty" — that yields
   *  source:'llm' and is never retried). Bounds retries so a listing whose
   *  LLM call persistently errors can't re-spend an LLM slot every run
   *  forever. Absent/0 on entries that never had a failed attempt. */
  llmFailures?: number
  /** Filenames of photos extracted from the best PDF attachment, relative to
   *  `.cache_zvg/images/<platform>/<externalId>/`. Empty when the PDF held no
   *  usable photos or no PDF was available. Served via /api/auction-image. */
  photos?: string[]
  /** ISO timestamp of when this extraction was produced. */
  at: string
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
  /** Total reported by the upstream platform; null when unknown or aggregated. */
  totalReported: number | null
  auctions: Auction[]
}
