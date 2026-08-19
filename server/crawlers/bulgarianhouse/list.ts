import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { BASE_URL, COUNTRY, FALLBACK_AUTHORITY, PLATFORM_ID } from './constants'
import { fetchPageHtml } from './fetch'
import { absoluteUrl, clean, parseNumber } from './text'

/** Safety cap, not an expected size: the live catalog sits around 50 pages
 *  (~715 active listings) at 14 items/page. A page beyond the real last one
 *  renders HTTP 200 with zero cards (verified live up to page 999), which is
 *  the actual loop-termination signal below — this cap only guards against a
 *  template change turning that into an infinite loop, and reaching it is
 *  reported as a failure rather than as a (silently truncated) catalog, same
 *  as pt/list.ts. */
const MAX_PAGES = 300

function listPageUrl(page: number): string {
  return `${BASE_URL}/properties/${page}.page?sort=date_desc`
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
    const items = parseListPage(await fetchPageHtml(listPageUrl(page), 'list'))
    if (items.length === 0) return auctions
    auctions.push(...items.map(mapItem))
  }
  throw new Error(
    `bulgarianhouse.com list: hit MAX_PAGES (${MAX_PAGES}) without reaching an empty page — pagination or the card markup changed`,
  )
}
