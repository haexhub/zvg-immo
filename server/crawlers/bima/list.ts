import type { Attachment, Auction } from '~/types/auction'
import { classifyAttachment } from '~/server/utils/classify-attachment'
import { API_BASE, AUTHORITY, CATEGORY, COMMERCIALIZATION_TYPE, COUNTRY, PAGE_SIZE, UA, WEB_BASE } from './constants'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

/**
 * BImA fills `buy_price` with a nominal 1 € whenever the sale runs as a
 * best-offer procedure instead of at a fixed price, and says so in the
 * listing's own text ("Bitte beachten Sie, dass 1,00 € als Platzhalter für
 * die Kaufpreiseingabe eingefügt wurde!", "Die oben beim Kaufpreis
 * angegebenen 1,- € dienen lediglich als Platzhalter." — both live, 2 of the
 * 20 current living/BUY offers). Carrying that through as a real
 * marketValueEur would put a 1 € house at the top of every price sort and
 * skew the price-per-m²/market-comparison aggregates, so it is treated the
 * same as a missing price. Genuine auction starting bids sit an order of
 * magnitude above it and are kept (e.g. a 10 € "Auktionslimit (Mindestgebot)"
 * on a scrap parcel, live).
 */
const PLACEHOLDER_BUY_PRICE_EUR = 1

interface JsonApiRef {
  id: string
  type: string
}

interface RelationshipRefs {
  data: JsonApiRef | JsonApiRef[] | null
}

/** Only the fields this adapter actually reads — the live response carries
 *  many more (energy/heating/interior attributes) that are left for the
 *  description text and the existing LLM/rules extraction pipeline. */
export interface OfferAttributes {
  offer_id: string | null
  title: string | null
  street: string | null
  house_number: string | null
  postcode: string | null
  city: string | null
  /** When false, the SPA itself shows neither the street/house number NOR
   *  postcode/city anywhere on the object's own detail page (verified live
   *  against a hidden-address listing) — buildAddress() below mirrors that. */
  show_address: boolean
  latitude: number | null
  longitude: number | null
  /** Always the field backing `display_price` while scoped to
   *  commercialization_type=BUY (see constants.ts) — read directly rather
   *  than through the generic display_price/display_price_attribute_name
   *  indirection, which exists to pick between buy_price/base_rent/etc. */
  buy_price: number | null
  living_space: number | null
  plot_area: number | null
  number_of_rooms: number | null
  description_note: string | null
  location_note: string | null
  furnishing_note: string | null
  other_note: string | null
  updated_at: string | null
}

export interface OfferJson {
  id: string
  type: string
  attributes: OfferAttributes
  relationships: {
    expose?: RelationshipRefs
    images?: RelationshipRefs
    downloads?: RelationshipRefs
  }
}

interface IncludedAttributes {
  url: string
  position?: number
  title?: string | null
  name?: string | null
  description?: string | null
  content_length?: number | null
}

export interface IncludedJson {
  id: string
  type: string
  attributes: IncludedAttributes
}

export interface SearchResponse {
  data: OfferJson[]
  included?: IncludedJson[]
  meta: { offset: string; total: number }
}

export interface SingleOfferResponse {
  data: OfferJson
  included?: IncludedJson[]
}

function buildSearchUrl(offset: number): string {
  const params = new URLSearchParams({
    q: '*',
    'filters[category]': CATEGORY,
    'filters[commercialization_type]': COMMERCIALIZATION_TYPE,
    sort: 'updated_at',
    order: 'desc',
    offset: String(offset),
    page_size: String(PAGE_SIZE),
  })
  return `${API_BASE}/search?${params.toString()}`
}

/** Same retry-on-5xx/network-error convention as gb/list.ts and dga-ag/list.ts
 *  — 4xx responses are not retried since a second attempt won't succeed. */
async function apiFetch<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return (await res.json()) as T
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`bundesimmobilien.de API ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`bundesimmobilien.de API ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

export function indexIncluded(included: IncludedJson[]): Map<string, IncludedJson> {
  return new Map(included.map((item) => [`${item.type}:${item.id}`, item]))
}

function refsOf(rel: RelationshipRefs | undefined): JsonApiRef[] {
  if (!rel?.data) return []
  return Array.isArray(rel.data) ? rel.data : [rel.data]
}

function resolveRefs(rel: RelationshipRefs | undefined, byKey: Map<string, IncludedJson>): IncludedJson[] {
  return refsOf(rel)
    .map((ref) => byKey.get(`${ref.type}:${ref.id}`))
    .filter((item): item is IncludedJson => item != null)
    .sort((a, b) => (a.attributes.position ?? 0) - (b.attributes.position ?? 0))
}

function mapIncludedDocument(item: IncludedJson, kindOverride?: Attachment['kind']): Attachment {
  const { attributes } = item
  const label = attributes.title || attributes.name || `Dokument ${item.id}`
  return {
    kind: kindOverride ?? classifyAttachment(attributes.title, attributes.name, attributes.description),
    label,
    filename: attributes.name || `${item.id}.pdf`,
    sizeBytes: attributes.content_length ?? null,
    fileId: item.id,
    proxyUrl: attributes.url,
  }
}

/** BImA itself hides the exact address for some listings — verified live:
 *  for a show_address=false object, neither the detail page's address/map
 *  link nor its meta description mention street, postcode or city anywhere,
 *  unlike a show_address=true object where both render the full address.
 *  Surfacing more than an actual visitor sees would defeat the point of
 *  treating this as ordinary public scraping. */
function buildAddress(a: OfferAttributes): string | null {
  if (!a.show_address) return null
  const street = [a.street, a.house_number].filter(Boolean).join(' ')
  const cityLine = [a.postcode, a.city].filter(Boolean).join(' ')
  return [street, cityLine].filter(Boolean).join(', ') || null
}

/** Mirrors the detail page's own section headings ("Objektbeschreibung",
 *  "Lage", "Ausstattung", "Sonstiges") so the composed text reads the same
 *  way a visitor sees it split up. Per-line whitespace/blank-line tidying
 *  happens afterwards via normalizeAuctionDescriptions (called by
 *  createCrawlResult in index.ts), so no cleanup is needed here. */
const DESCRIPTION_SECTIONS: ReadonlyArray<[keyof OfferAttributes, string]> = [
  ['description_note', 'Objektbeschreibung'],
  ['location_note', 'Lage'],
  ['furnishing_note', 'Ausstattung'],
  ['other_note', 'Sonstiges'],
]

function buildDescription(a: OfferAttributes): string | null {
  const sections = DESCRIPTION_SECTIONS.map(([key, label]) => {
    const text = a[key]
    return typeof text === 'string' && text.trim() ? `${label}\n${text.trim()}` : null
  }).filter((s): s is string => s != null)
  return sections.join('\n\n') || null
}

export function mapOffer(offer: OfferJson, byKey: Map<string, IncludedJson>, platformId: string): Auction {
  const a = offer.attributes
  const images = resolveRefs(offer.relationships.images, byKey)
  const downloads = resolveRefs(offer.relationships.downloads, byKey)
  const exposeItem = resolveRefs(offer.relationships.expose, byKey)[0]

  const photoUrls = images.map((img) => img.attributes.url).filter(Boolean)
  const attachments: Attachment[] = []
  if (exposeItem) attachments.push(mapIncludedDocument(exposeItem, 'brochure'))
  for (const dl of downloads) attachments.push(mapIncludedDocument(dl))

  const detailUrl = `${WEB_BASE}/details?id=${offer.id}`
  const marketValueEur = a.buy_price != null && a.buy_price > PLACEHOLDER_BUY_PRICE_EUR ? a.buy_price : null

  return {
    platform: platformId,
    country: COUNTRY,
    // BImA exposes no sub-region filter of its own (see constants.ts's
    // BIMA_REGIONS) — same "no sub-region a user would filter by" precedent
    // as gb/auctionhouse and bg/zapori, even though individual objects do
    // carry a federal_state attribute.
    region: '',
    externalId: offer.id,
    // The site's own "Angebotsnummer" (verified live on the detail page) —
    // a stable public reference number, not a court case number.
    caseNumber: a.offer_id ?? '',
    authority: AUTHORITY,
    title: a.title || null,
    address: buildAddress(a),
    marketValueEur,
    marketValueText: marketValueEur != null ? `${marketValueEur.toLocaleString('de-DE')} €` : null,
    // No fixed auction date for BImA sales (fixed-price/best-offer, not a
    // scheduled Termin) — left null throughout this adapter.
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: a.updated_at ?? null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: detailUrl,
    attachments,
    description: buildDescription(a),
    photoCount: photoUrls.length,
    thumbnailUrl: photoUrls[0] ?? null,
    photoUrls,
    sourceLivingAreaSqm: a.living_space ?? null,
    sourceLandAreaSqm: a.plot_area ?? null,
    sourceRooms: a.number_of_rooms ?? null,
    lat: a.latitude ?? null,
    lng: a.longitude ?? null,
  }
}

/**
 * Pages through the whole living/BUY result set via offset/page_size until
 * meta.total is exhausted — unlike dga-ag's single unpaginated page, this
 * API genuinely paginates server-side.
 */
export async function fetchAllListings(platformId: string): Promise<{ auctions: Auction[]; total: number }> {
  const auctions: Auction[] = []
  let offset = 0
  let total = 0
  for (;;) {
    const page = await apiFetch<SearchResponse>(buildSearchUrl(offset))
    total = page.meta.total
    const byKey = indexIncluded(page.included ?? [])
    for (const offer of page.data) auctions.push(mapOffer(offer, byKey, platformId))
    offset += page.data.length
    if (page.data.length === 0 || offset >= total) break
  }
  return { auctions, total }
}
