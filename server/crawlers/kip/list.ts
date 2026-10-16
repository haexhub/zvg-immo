import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import type { RegionInfo } from '../types'
import { BASE_URL, COUNTRY, FALLBACK_AUTHORITY, KIP_CATEGORIES, KIP_STATE_SLUG, PLATFORM_ID, type KipCategory } from './constants'
import { fetchKipPage } from './fetch'
import { absoluteUrl, applyAreaFacts, clean } from './text'

export interface ListItem {
  externalId: string
  title: string | null
  /** "<PLZ> <Stadt>" as shown on the list card — the only location kip.net
   *  gives before the detail page (see detail.ts for the exact-address
   *  override, which not every listing discloses). */
  postalCity: string | null
  thumbnailUrl: string | null
  detailUrl: string
  facts: Map<string, string>
}

/**
 * Every current object for one category is rendered server-side across one
 * or more "seite" (page) query pages (verified live) — this parses a single
 * already-fetched page.
 */
export function parseListPage(html: string): ListItem[] {
  const $ = load(html)
  const items: ListItem[] = []

  $('.list-element').each((_i, el) => {
    const $el = $(el)
    const externalId = ($el.find('a[id^="objekt_"]').first().attr('id') ?? '').replace(/^objekt_/, '')
    if (!externalId) return

    const titleAnchor = $el.find('h3 a').first()
    const href = titleAnchor.attr('href')
    if (!href) return

    const facts = new Map<string, string>()
    $el.find('dl').each((_j, dl) => {
      const $dl = $(dl)
      const key = clean($dl.find('dd small').first().text())
      const value = clean($dl.find('dt').first().text())
      if (key && value) facts.set(key, value)
    })

    const thumbSrc = $el.find('img.lazy').first().attr('data-original')

    items.push({
      externalId,
      title: clean(titleAnchor.text()) || null,
      postalCity: clean($el.find('h4').first().text()) || null,
      thumbnailUrl: thumbSrc ? absoluteUrl(thumbSrc) : null,
      detailUrl: absoluteUrl(href),
      facts,
    })
  })

  return items
}

/** Reads the "Seite 1"/"Seite 2"/... page-select dropdown that every
 *  category's filter form carries, to learn the true page count instead of
 *  guessing from a fixed page size — verified live to reflect the real
 *  result count (Bremen/Häuser: 2 pages for 27 objects at 20/page). Defaults
 *  to 1 when the dropdown is absent (e.g. a category with zero results,
 *  such as "sonstige-immobilien" in both registered states right now). */
export function extractPageCount(html: string): number {
  const $ = load(html)
  const count = $('select[name="seite_"] option').length
  return count > 0 ? count : 1
}

/** Maps the list card's own fields; applyAreaFacts (text.ts) is applied by
 *  the caller right after, to fill in marketValueEur/-Text and the
 *  source*Sqm/-Rooms fields from the same card's dl/dt/dd facts. */
export function mapItem(item: ListItem, regionName: string): Auction {
  return {
    platform: PLATFORM_ID,
    country: COUNTRY,
    region: regionName,
    externalId: item.externalId,
    // A property marketplace, not a court/government registry — no case
    // number to publish, same precedent as gb/list.ts and dga-ag/list.ts.
    caseNumber: '',
    authority: FALLBACK_AUTHORITY,
    title: item.title,
    address: item.postalCity,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: item.detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: item.detailUrl,
    attachments: [],
    description: null,
    photoCount: item.thumbnailUrl ? 1 : 0,
    thumbnailUrl: item.thumbnailUrl,
  }
}

/** Builds the POST body kip.net's own pagination JS submits when a page
 *  number other than 1 is picked from the "seite_" dropdown — see
 *  fetchCategoryListings. */
function paginationBody(category: KipCategory, page: number): URLSearchParams {
  return new URLSearchParams({
    [category.filterField]: '1',
    su_filter_gewerbe: '0',
    kauf: 'on',
    sort: 'k0',
    anzperseite: '20',
    seite: String(page),
    angebote_kom: 'on',
    angebote_priv: 'on',
    angebote_gew: 'on',
  })
}

/**
 * Fetches every page of one category for one state. Page 1 is a plain GET;
 * later pages must be POSTed to ".../<category>/<page>" reusing the PHPSESSID
 * cookie page 1's response set — verified live that without that session
 * continuity, kip.net's own pagination drifts (overlapping/incomplete result
 * windows across requests), while with it, pages 1..N partition the result
 * set with zero overlap.
 */
async function fetchCategoryListings(
  stateSlug: string, regionName: string, category: KipCategory,
): Promise<Auction[]> {
  const baseUrl = `${BASE_URL}/${stateSlug}/kaufen/${category.slug}`
  const byId = new Map<string, Auction>()

  const first = await fetchKipPage(baseUrl, 'GET', undefined, null)
  for (const item of parseListPage(first.html)) {
    const auction = mapItem(item, regionName)
    applyAreaFacts(auction, item.facts)
    byId.set(item.externalId, auction)
  }

  const totalPages = extractPageCount(first.html)
  let cookie = first.cookie
  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchKipPage(`${baseUrl}/${page}`, 'POST', paginationBody(category, page), cookie)
    cookie = next.cookie
    for (const item of parseListPage(next.html)) {
      if (byId.has(item.externalId)) continue
      const auction = mapItem(item, regionName)
      applyAreaFacts(auction, item.facts)
      byId.set(item.externalId, auction)
    }
  }

  return [...byId.values()]
}

export async function fetchRegionListings(region: RegionInfo): Promise<Auction[]> {
  const stateSlug = KIP_STATE_SLUG[region.code]
  if (!stateSlug) return []

  const auctions: Auction[] = []
  for (const category of KIP_CATEGORIES) {
    auctions.push(...(await fetchCategoryListings(stateSlug, region.name, category)))
  }
  return auctions
}
