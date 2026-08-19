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
  UA,
  type AloCategory,
  type AloOblast,
} from './constants'
import { absoluteUrl, buildAddress, clean, formatPrice, parseAreaSqm, parsePrice, parseRoomCount } from './text'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

/** Same retry-on-5xx/network-error convention as bcpea/list.ts, except a 404
 *  is not an error here: alo.bg 404s any page number past the last one
 *  (verified live), which is how fetchAllListings learns it has reached the
 *  end of a region/category's results. A 404 on page 1 is a real config
 *  problem (unknown region_id/category slug) and still throws. */
async function fetchListPage(category: AloCategory, regionId: string, page: number): Promise<string | null> {
  const url = `${BASE_URL}/obiavi/imoti-prodajbi/${category.slug}/?region_id=${regionId}&page=${page}`
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'bg,en;q=0.8', 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return await res.text()
      if (res.status === 404 && page > 1) return null
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok && !(res.status === 404 && page > 1)) {
      if (res.status < 500) throw new Error(`alo.bg list HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`alo.bg list HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
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
 * matching on that id rather than either tier's own class name covers both
 * uniformly. Facts (Цена/Квадратура/РЗП/Двор/Вид на имота/...) sit in
 * `.ads-params-multi[title]` spans shared identically by both templates.
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

    const imgSrc = $el.find('[class$="-image-img"]').first().attr('src')
    const authority = $el.find('[class$="-publisher"] img[title]').first().attr('title')

    items.push({
      externalId,
      title: clean($el.find('h3').first().text()),
      address: clean($el.find('[class$="-item-address"]').first().text()),
      authority: clean(authority) ?? null,
      thumbnailUrl: imgSrc ? absoluteUrl(imgSrc) : null,
      detailUrl: absoluteUrl(href),
      facts,
    })
  })

  return items
}

export function mapItem(item: ListItem, oblast: AloOblast): Auction {
  const price = parsePrice(item.facts.get('Цена'))
  const livingAreaSqm = parseAreaSqm(item.facts.get('Квадратура') ?? item.facts.get('РЗП'))
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

async function fetchCategoryListings(category: AloCategory, oblast: AloOblast): Promise<Auction[]> {
  const byId = new Map<string, Auction>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchListPage(category, oblast.regionId, page)
    if (html == null) break
    const items = parseListPage(html)
    if (items.length === 0) break
    for (const item of items) {
      if (byId.has(item.externalId)) continue
      byId.set(item.externalId, mapItem(item, oblast))
    }
  }
  return [...byId.values()]
}

export async function fetchAllListings(): Promise<Auction[]> {
  const auctions: Auction[] = []
  for (const oblast of ALO_OBLASTI) {
    for (const category of ALO_CATEGORIES) {
      auctions.push(...(await fetchCategoryListings(category, oblast)))
    }
  }
  return auctions
}
