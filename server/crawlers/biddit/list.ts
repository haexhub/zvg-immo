import type { Auction } from '~/types/auction'
import { BIDDIT_BASE, COUNTRY, HANDLING_METHOD_PUBLIC, PAGE_SIZE, REGION_NAME, UA } from './constants'
import { formatAddress, pickLocalized, type AddressLike, type LocalizedString } from './text'

interface SearchProperty {
  propertyType?: string | null
  propertySubtype?: string | null
  title?: LocalizedString | null
  address?: AddressLike | null
}

interface SearchItemInner {
  lotId: string
  referenceCode: string
  organisationId?: string | null
  organisationReference?: string | null
  handlingMethod: string
  firstPublicationDateTime?: string | null
  biddingStartDateTime?: string | null
  biddingEndDateTime?: string | null
  startingPrice?: number | null
  currentPrice?: number | null
  publicSaleStatus?: string | null
  withdrawn?: boolean
  properties?: SearchProperty[]
}

interface SearchHit {
  content: SearchItemInner
}

interface SearchPage {
  content: SearchHit[]
  totalElements: number
  totalPages: number
  numberOfElements: number
  first: boolean
  last: boolean
}

const FETCH_TIMEOUT_MS = 20_000

export async function fetchSearchPage(page: number): Promise<SearchPage> {
  const url = `${BIDDIT_BASE}/api/eco/search-service/lot/_search?page=${page}&pageSize=${PAGE_SIZE}&handlingMethods=${HANDLING_METHOD_PUBLIC}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: `${BIDDIT_BASE}/`,
      },
    })
    if (!res.ok) throw new Error(`biddit listing HTTP ${res.status}`)
    return (await res.json()) as SearchPage
  } finally {
    clearTimeout(timer)
  }
}

/** Detail-endpoint refs needed for enrichment — kept alongside the Auction
 *  so the per-item HTTP calls don't need a second lookup. */
export interface MappedAuction {
  auction: Auction
  organisationId: string | null
}

function mapItem(inner: SearchItemInner, platformId: string): MappedAuction | null {
  if (!inner.referenceCode) return null
  const prop = inner.properties?.[0] ?? null
  // Biddit's public lot URL is `/{locale}/catalog/detail/{id}`, not `/lot/{id}`
  // (which 500s) — verified against their sitemap_index.xml. We default to the
  // German UI since the consuming map is German-language; users can switch
  // language in biddit's own UI if they want. fr/nl/de all render the same
  // underlying lot data.
  const detailUrlUpstream = `${BIDDIT_BASE}/de/catalog/detail/${encodeURIComponent(inner.referenceCode)}`

  // publicSaleStatus values seen on the API: CURRENT (active), WITHDRAWN
  // (lot pulled), CLOSED (bidding done). The `withdrawn` boolean is a more
  // robust signal because the status string also flips after the auction
  // closes successfully — which is not the same as "aufgehoben".
  const aufgehoben = Boolean(inner.withdrawn) || inner.publicSaleStatus === 'WITHDRAWN'

  // Listing exposes startingPrice (the Mindestgebot), not the appraised
  // value. estimatedPrice — the Verkehrswert equivalent — is detail-only,
  // so this stays null here until enrichment fills it in.
  const auction: Auction = {
    platform: platformId,
    country: COUNTRY,
    region: REGION_NAME,
    zvgId: inner.referenceCode,
    aktenzeichen: inner.referenceCode,
    amtsgericht: inner.organisationReference ?? '',
    objekt: pickLocalized(prop?.title) ?? prop?.propertyType ?? null,
    adresse: formatAddress(prop?.address),
    verkehrswertEur: null,
    verkehrswertText: null,
    terminIso: inner.biddingEndDateTime ?? inner.biddingStartDateTime ?? null,
    terminText: inner.biddingEndDateTime ?? null,
    aufgehoben,
    letzteAktualisierungIso: inner.firstPublicationDateTime ?? null,
    pdfUrl: null,
    detailUrl: detailUrlUpstream,
    pdfUrlUpstream: null,
    detailUrlUpstream,
    attachments: [],
    beschreibung: null,
    fotoCount: 0,
    thumbnailUrl: null,
  }
  return { auction, organisationId: inner.organisationId ?? null }
}

export interface ListResult {
  totalReported: number
  auctions: MappedAuction[]
}

/** Walks the paginated search endpoint once and maps every hit. The total
 *  count is taken from the first page; subsequent pages run in parallel up
 *  to a small fan-out. */
export async function fetchAllPublicSales(platformId: string): Promise<ListResult> {
  const first = await fetchSearchPage(0)
  const total = first.totalElements
  const mapped: MappedAuction[] = first.content
    .map((h) => mapItem(h.content, platformId))
    .filter((x): x is MappedAuction => x != null)

  if (first.totalPages <= 1) return { totalReported: total, auctions: mapped }

  // Pages 1..N — bounded concurrency keeps us well behind the rate limit
  // and parallelises the bulk of the fetches. 13 pages at concurrency 4
  // finishes in roughly 4 sequential round trips.
  const remaining = first.totalPages - 1
  const concurrency = 4
  const queue = Array.from({ length: remaining }, (_, i) => i + 1)
  let cursor = 0
  const results: MappedAuction[][] = []
  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const idx = cursor++
      const pageNum = queue[idx]
      if (pageNum == null) continue
      try {
        const page = await fetchSearchPage(pageNum)
        results.push(
          page.content
            .map((h) => mapItem(h.content, platformId))
            .filter((x): x is MappedAuction => x != null),
        )
      } catch (err) {
        console.warn(`[biddit] page ${pageNum} failed: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  for (const arr of results) mapped.push(...arr)
  // The Elasticsearch index ranks results live, so when several pages
  // fetch concurrently a lot can appear on two adjacent pages. Dedup by
  // referenceCode — without this, `auctions.length > totalReported` and
  // the same property gets two pins on the map.
  const seen = new Set<string>()
  const unique = mapped.filter((m) => {
    const k = m.auction.zvgId
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { totalReported: total, auctions: unique }
}
