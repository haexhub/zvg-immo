import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { BASE_URL, COUNTRY, CRAWL_DELAY_MS, FALLBACK_AUTHORITY, PLATFORM_ID, UA } from './constants'
import { absoluteUrl, clean, parseNumber } from './text'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2
/** Safety cap, not an expected size: the live catalog sits around 50-60 pages
 *  (~700-900 active listings) at 14 items/page. A page beyond the real last
 *  one renders HTTP 200 with zero cards (verified live up to page 999), which
 *  is the actual loop-termination signal below — this cap only guards
 *  against a template change turning that into an infinite loop. */
const MAX_PAGES = 300

function listPageUrl(page: number): string {
  return `${BASE_URL}/properties/${page}.page?sort=date_desc`
}

/** Same retry-on-5xx/network-error convention as dga-ag/list.ts and
 *  gb/list.ts — 4xx responses are not retried since a second attempt won't
 *  succeed. */
async function fetchListPage(page: number): Promise<string> {
  const url = listPageUrl(page)
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`bulgarianhouse.com list HTTP ${res.status} for ${url}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`bulgarianhouse.com list HTTP ${res.status} for ${url}`)
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

export interface ListItem {
  externalId: string
  title: string | null
  /** Oblast name from the card's own <h3> (e.g. "Burgas") — the only location
   *  the list view gives before the detail page (see detail.ts for the finer
   *  "<Town> (<Oblast>)" override). */
  oblast: string | null
  priceEur: number | null
  priceText: string | null
  livingAreaSqm: number | null
  landAreaSqm: number | null
  /** True when the card carries a ".sold" badge — the item is no longer for
   *  sale. Mapped onto Auction.cancelled, the same "no longer available"
   *  semantics agi/list.ts documents for its own "Aggiudicata" (sold) status. */
  sold: boolean
  thumbnailUrl: string | null
  detailUrl: string
}

/**
 * Parses one already-fetched `/properties/<n>.page?sort=date_desc` page. This
 * single combined feed (not a per-oblast one) is what BG_REGIONS' single
 * 'all' region crawls — see constants.ts.
 */
export function parseListPage(html: string): ListItem[] {
  const $ = load(html)
  const items: ListItem[] = []

  $('ul.listing > li').each((_i, li) => {
    const $li = $(li)
    const $a = $li.find('a[rel="bookmark"]').first()
    const href = $a.attr('href')
    if (!href) return

    const externalId = href.match(/-(\d+)\/?$/)?.[1]
    if (!externalId) return

    const priceText = clean($a.find('.price').first().text()) || null
    const thumbSrc = $a.find('img').first().attr('src')

    items.push({
      externalId,
      title: clean($a.find('p.description').first().text()) || null,
      oblast: clean($a.find('h3').first().text()) || null,
      priceEur: parseNumber(priceText),
      priceText,
      livingAreaSqm: parseNumber($a.find('.listing-info-area').first().text()),
      landAreaSqm: parseNumber($a.find('.listing-info-garden').first().text()),
      sold: $a.find('.sold').length > 0,
      thumbnailUrl: thumbSrc ? absoluteUrl(thumbSrc) : null,
      detailUrl: absoluteUrl(href),
    })
  })

  return items
}

export function mapItem(item: ListItem): Auction {
  return {
    platform: PLATFORM_ID,
    country: COUNTRY,
    region: item.oblast ?? '',
    externalId: item.externalId,
    // A private real-estate agency, not a court/government registry — no
    // case number to publish, same precedent as kip/list.ts and
    // dga-ag/list.ts.
    caseNumber: '',
    authority: FALLBACK_AUTHORITY,
    title: item.title,
    // No street-level address is ever published (verified on every sampled
    // listing) — the oblast name is the best available value until detail.ts
    // refines it with the finer "<Town>, <Oblast>" reading.
    address: item.oblast,
    marketValueEur: item.priceEur,
    marketValueText: item.priceText,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: item.sold,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: item.detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: item.detailUrl,
    attachments: [],
    description: null,
    photoCount: item.thumbnailUrl ? 1 : 0,
    thumbnailUrl: item.thumbnailUrl,
    sourceLivingAreaSqm: item.livingAreaSqm,
    sourceLandAreaSqm: item.landAreaSqm,
  }
}

export async function fetchAllListings(): Promise<Auction[]> {
  const auctions: Auction[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchListPage(page)
    const items = parseListPage(html)
    if (items.length === 0) break
    auctions.push(...items.map(mapItem))
    if (page < MAX_PAGES) await new Promise((resolve) => setTimeout(resolve, CRAWL_DELAY_MS))
  }
  return auctions
}
