import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import {
  ALO_CATEGORIES,
  ALO_OBLASTI,
  BASE_URL,
  COUNTRY,
  FALLBACK_AUTHORITY,
  MAX_PAGES,
  PLATFORM_ID,
  type AloOblast,
} from './constants'
import { fetchAloPage } from './fetch'
import { absoluteUrl, buildAddress, clean, formatPrice, parseAreaSqm, parsePrice, parseRoomCount } from './text'

/** Retries (including on 429) and the site-wide crawl delay live in
 *  fetch.ts. A 404 is not an error here: alo.bg 404s any page number past the
 *  last one (verified live), which is how fetchCategoryListings learns it has
 *  reached the end of an oblast/category's results. A 404 on page 1 is a real
 *  config problem (unknown region_id/category slug) and still throws. */
export async function fetchListPage(categorySlug: string, regionId: string, page: number): Promise<string | null> {
  const url = `${BASE_URL}/obiavi/imoti-prodajbi/${categorySlug}/?region_id=${regionId}&page=${page}`
  const res = await fetchAloPage(url)
  if (res.ok) return await res.text()
  if (res.status === 404 && page > 1) return null
  throw new Error(`alo.bg list ${url}: HTTP ${res.status}`)
}

export interface ListItem {
  externalId: string
  title: string | null
  address: string | null
  authority: string | null
  thumbnailUrl: string | null
  detailUrl: string
  facts: Map<string, string>
}

/**
 * Both promoted tiers ("листтоп"/TOP and "листвип"/VIP — verified live to be
 * the only two card templates in use, VIP being the de-facto standard tier
 * rather than a rare upsell) share one `id="adrows_<id>"` container, so
 * matching on that id rather than either tier's own class name covers title,
 * address, publisher and thumbnail uniformly.
 *
 * Their facts (Цена/Квадратура/РЗП/Двор/Вид на имота/...) do NOT share one
 * markup, though: `listvip-item` puts each fact in a `.ads-params-multi` span
 * carrying the label in its `title` attribute, while `listtop-item` renders a
 * label/value table where the same label sits in a sibling `.ads-param-title`
 * div (with a trailing colon) and the value in `.ads-params-cell`. Both are
 * read below into one label -> value map, so mapItem stays template-agnostic.
 */
export function parseListPage(html: string): ListItem[] {
  const $ = load(html)
  const items: ListItem[] = []

  $('[id^="adrows_"]').each((_i, el) => {
    const $el = $(el)
    const externalId = ($el.attr('id') ?? '').replace(/^adrows_/, '')
    // The title anchor wraps the <h3> ("<a href="..."><h3>...</h3></a>"),
    // not the other way around.
    const href = $el.find('a:has(h3)').first().attr('href')
    if (!externalId || !href) return

    const facts = new Map<string, string>()
    $el.find('.ads-params-multi[title]').each((_j, span) => {
      const $span = $(span)
      const label = $span.attr('title')
      if (!label || facts.has(label)) return
      // The "Цена" field alone embeds a redundant visible label
      // ("<span class="ads-param-name">Цена</span>: 210 332 €") ahead of the
      // actual value — every other field's plain text already matches its
      // `title` attribute, so only this one needs the nested price span.
      const priceSpan = $span.find('.price_nowrap').first()
      const value = label === 'Цена' && priceSpan.length > 0 ? clean(priceSpan.text()) : clean($span.text())
      if (value) facts.set(label, value)
    })
    // TOP-tier table layout (see the doc comment above). Its label lives
    // outside the value cell, so unlike the VIP spans no price special case is
    // needed. TOP placements are concentrated on a category's first page —
    // verified live: all 30 cards on Plovdiv's first page (both categories),
    // 13 of 30 on Sofia's, none on any deeper page — so reading only the VIP
    // markup left those cards with no price, area or room count at all.
    $el.find('.ads-params-row').each((_j, row) => {
      const $row = $(row)
      const label = clean($row.find('.ads-param-title').first().text())?.replace(/\s*:\s*$/, '')
      if (!label || facts.has(label)) return
      const value = clean($row.find('.ads-params-cell').first().text())
      if (value) facts.set(label, value)
    })

    const imgSrc = $el.find('[class$="-image-img"]').first().attr('src')
    // Branded ads carry the agency name twice — in the logo's `title` and in a
    // `.hidden-xs` name span — but agencies that never uploaded a logo have
    // only the span, and reading the logo alone would file those under the
    // private-seller fallback. The block's other span ("днешна обява", the
    // posting age) is not `.hidden-xs` and must not be picked up.
    const $publisher = $el.find('[class$="-publisher"]').first()
    const authority =
      clean($publisher.find('img[title]').first().attr('title')) ??
      clean($publisher.find('span.hidden-xs').first().text())

    items.push({
      externalId,
      title: clean($el.find('h3').first().text()),
      address: clean($el.find('[class$="-item-address"]').first().text()),
      authority,
      thumbnailUrl: imgSrc ? absoluteUrl(imgSrc) : null,
      detailUrl: absoluteUrl(href),
      facts,
    })
  })

  return items
}

export function mapItem(item: ListItem, oblast: AloOblast): Auction {
  const price = parsePrice(item.facts.get('Цена'))
  // Parse-then-fallback, not string-then-parse: a present-but-unparseable
  // Квадратура ("по договаряне") must not suppress a usable РЗП.
  const livingAreaSqm = parseAreaSqm(item.facts.get('Квадратура')) ?? parseAreaSqm(item.facts.get('РЗП'))
  const landAreaSqm = parseAreaSqm(item.facts.get('Двор'))

  return {
    platform: PLATFORM_ID,
    country: COUNTRY,
    region: oblast.name,
    externalId: item.externalId,
    // A private classifieds marketplace, not a court/government registry —
    // no case number to publish, same precedent as kip/list.ts.
    caseNumber: '',
    authority: item.authority ?? FALLBACK_AUTHORITY,
    title: item.title,
    address: buildAddress(item.address),
    marketValueEur: price,
    marketValueText: formatPrice(price),
    sourceLivingAreaSqm: livingAreaSqm,
    sourceLandAreaSqm: landAreaSqm,
    sourceRooms: parseRoomCount(item.facts.get('Вид на имота')),
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

export async function fetchCategoryListings(categorySlug: string, oblast: AloOblast): Promise<Auction[]> {
  const byId = new Map<string, Auction>()
  let page = 1
  try {
    for (; page <= MAX_PAGES; page++) {
      const html = await fetchListPage(categorySlug, oblast.regionId, page)
      if (html == null) break
      const items = parseListPage(html)
      if (items.length === 0) break
      for (const item of items) {
        if (byId.has(item.externalId)) continue
        byId.set(item.externalId, mapItem(item, oblast))
      }
    }
  } catch (err) {
    // A full cycle is ~1,140 sequential page fetches, so one page that still
    // fails after fetch.ts's retries is likely enough that it must not discard
    // the pages already walked: search serves from the `auctions` table, which
    // this walk's surviving listings still reach, and the rest is picked up
    // next cycle. A walk that yielded nothing at all is a different story —
    // an unknown region_id/category slug or an outright block — and stays a
    // hard failure rather than a silent zero-listing "success".
    if (byId.size === 0) throw err
    console.warn(
      `[alo] ${oblast.name}/${categorySlug}: page ${page} failed, keeping the ${byId.size} listings walked so far — ${(err as Error).message}`,
    )
    return [...byId.values()]
  }
  // Only reachable when the walk never hit a 404/empty page, i.e. the cap cut
  // it short — otherwise indistinguishable from a complete crawl. See MAX_PAGES.
  if (page > MAX_PAGES) {
    console.warn(
      `[alo] ${oblast.name}/${categorySlug}: MAX_PAGES (${MAX_PAGES}) reached, later listings were dropped — raise the cap`,
    )
  }
  return [...byId.values()]
}

export async function fetchAllListings(): Promise<Auction[]> {
  const auctions: Auction[] = []
  for (const oblast of ALO_OBLASTI) {
    for (const categorySlug of ALO_CATEGORIES) {
      auctions.push(...(await fetchCategoryListings(categorySlug, oblast)))
    }
  }
  return auctions
}
