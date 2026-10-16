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

/** "2026-07-15T14:00:00.000Z" → "15.07.2026, 16:00 Uhr" (Belgian local time),
 *  matching the human-readable auctionDateText the other platforms provide. */
function formatTerminText(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const formatted = date.toLocaleString('de-DE', {
    timeZone: 'Europe/Brussels',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${formatted} Uhr`
}

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
  // closes successfully — which is not the same as "cancelled".
  const cancelled = Boolean(inner.withdrawn) || inner.publicSaleStatus === 'WITHDRAWN'

  // Listing exposes startingPrice (the Mindestgebot), not the appraised
  // value. estimatedPrice — the Verkehrswert equivalent — is detail-only,
  // so this stays null here until enrichment fills it in.
  const auction: Auction = {
    platform: platformId,
    country: COUNTRY,
    region: REGION_NAME,
    externalId: inner.referenceCode,
    caseNumber: inner.referenceCode,
    authority: inner.organisationReference ?? '',
    title: pickLocalized(prop?.title) ?? prop?.propertyType ?? null,
    address: formatAddress(prop?.address),
    marketValueEur: null,
    marketValueText: null,
    startingBid: inner.startingPrice ?? null,
    currentBid: inner.currentPrice ?? null,
    auctionDateIso: inner.biddingEndDateTime ?? inner.biddingStartDateTime ?? null,
    auctionDateText: formatTerminText(inner.biddingEndDateTime),
    cancelled,
    sourceUpdatedIso: inner.firstPublicationDateTime ?? null,
    pdfUrl: null,
    detailUrl: detailUrlUpstream,
    pdfUrlUpstream: null,
    detailUrlUpstream,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
  return { auction, organisationId: inner.organisationId ?? null }
}

export interface ListResult {
  totalReported: number
  auctions: MappedAuction[]
  /** False when a page failed or fewer distinct hits arrived than the index
   *  reported — the missing lots must not be treated as gone. */
  complete: boolean
}

/** Walks the paginated search endpoint once and maps every hit. The total
 *  count is taken from the first page; subsequent pages run in parallel up
 *  to a small fan-out. */
export async function fetchAllPublicSales(platformId: string): Promise<ListResult> {
  const first = await fetchSearchPage(0)
  const total = first.totalElements
  const hits: SearchHit[] = [...first.content]

  // Pages 1..N — bounded concurrency keeps us well behind the rate limit
  // and parallelises the bulk of the fetches. 13 pages at concurrency 4
  // finishes in roughly 4 sequential round trips.
  const queue = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 1)
  const concurrency = 4
  let cursor = 0
  let failedPages = 0
  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const idx = cursor++
      const pageNum = queue[idx]
      if (pageNum == null) continue
      try {
        const page = await fetchSearchPage(pageNum)
        hits.push(...page.content)
      } catch (err) {
        failedPages++
        console.warn(`[biddit] page ${pageNum} failed: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  // The Elasticsearch index ranks results live, so when several pages
  // fetch concurrently a lot can appear on two adjacent pages. Dedup by
  // referenceCode — without this, `auctions.length > totalReported` and
  // the same property gets two pins on the map.
  const seen = new Set<string>()
  let distinctHits = 0
  const auctions: MappedAuction[] = []
  for (const hit of hits) {
    const code = hit.content.referenceCode
    if (code) {
      if (seen.has(code)) continue
      seen.add(code)
    }
    distinctHits++
    const mapped = mapItem(hit.content, platformId)
    if (mapped) auctions.push(mapped)
  }
  // Each duplicate pushed some other lot past a page boundary, so with a
  // stable total it is missing from this run. A lot added mid-crawl can mask
  // one that slipped this way — ponytail: count-based check only; a stable
  // sort parameter on the search API, if biddit ever offers one, would close it.
  if (distinctHits < total) {
    console.warn(`[biddit] ${distinctHits} distinct hits for ${total} reported lots — run incomplete`)
  }
  return { totalReported: total, auctions, complete: failedPages === 0 && distinctHits >= total }
}
