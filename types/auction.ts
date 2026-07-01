import type { PropertyType } from '~/lib/objektart'

export type AttachmentKind = 'bekanntmachung' | 'foto' | 'exposee' | 'gutachten' | 'sonstiges'

export interface Attachment {
  kind: AttachmentKind
  label: string
  filename: string
  sizeBytes: number | null
  fileId: string
  /** Local proxy URL serving the file with the correct upstream Referer. */
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
  /** Stable per-platform id for the auction (kept as 'zvgId' for historical
   *  reasons; non-DE crawlers fill it with their own native identifier). */
  zvgId: string
  aktenzeichen: string
  amtsgericht: string
  objekt: string | null
  adresse: string | null
  verkehrswertEur: number | null
  verkehrswertText: string | null
  terminIso: string | null
  terminText: string | null
  aufgehoben: boolean
  letzteAktualisierungIso: string | null
  /** Local proxy URL — direct upstream links may require a platform-specific Referer. */
  pdfUrl: string | null
  /** Local proxy URL for the upstream Detailansicht. */
  detailUrl: string
  /** Original upstream URL for the PDF (for reference). */
  pdfUrlUpstream: string | null
  /** Original upstream URL for the detail page (for reference). */
  detailUrlUpstream: string
  /** All attachments scraped from the Detailansicht page. */
  attachments: Attachment[]
  /** Free-text description scraped from the detail page (Beschreibung field). */
  beschreibung: string | null
  /** Number of photos available (counted from Foto attachments and embedded JPEGs). */
  fotoCount: number
  /** Local URL for a JPEG thumbnail of the first photo, if any. */
  thumbnailUrl: string | null
  /** ISO timestamp of the last successful (non-throwing) `enrichOne` call.
   *  Absent on the fresh listing crawl; set on the auction-snapshot side and
   *  preserved across snapshot merges. Used by the enrich task to distinguish
   *  "detail never fetched" from "fetched, and the listing legitimately has no
   *  attachments/beschreibung" — the latter would otherwise be retried on every
   *  run. */
  detailFetchedAt?: string | null
  /** Structured fields extracted from the listing text/documents. Always absent
   *  at crawl time — populated read-only from the extraction cache by the
   *  /api/auctions overlay (mirrors how verkehrswertEur is filled). */
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
  source: 'rules' | 'llm'
  confidence: 'high' | 'low'
  /** Filenames of photos extracted from the best PDF attachment, relative to
   *  `.cache_zvg/images/<platform>/<zvgId>/`. Empty when the PDF held no
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
