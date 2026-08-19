import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { BASE_URL, COUNTRY, LIST_PATH, MAX_PAGES, PAGE_SIZE, UA } from './constants'
import {
  buildAddress,
  clean,
  formatPrice,
  isLandTitle,
  isNonPropertyTitle,
  parseAreaSqm,
  parseDateTime,
  parsePrice,
  parseRoomCount,
} from './text'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

/** Same retry-on-5xx/network-error convention as dga-ag/list.ts — 4xx
 *  responses are not retried since a second attempt won't succeed. */
async function fetchListPage(page: number): Promise<string> {
  const url = `${BASE_URL}${LIST_PATH}?perpage=${PAGE_SIZE}&p=${page}`
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'bg,en;q=0.8', 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`sales.bcpea.org list HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`sales.bcpea.org list HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

export interface ListItem {
  externalId: string
  title: string | null
  areaText: string | null
  priceText: string | null
  settlement: string | null
  street: string | null
  courtDistrict: string | null
  authority: string | null
  announcedAtText: string | null
  thumbnailUrl: string | null
  detailUrl: string
}

/**
 * One search-result card ("item__group") per lot. Labelled facts
 * (НАСЕЛЕНО МЯСТО/Адрес/ОКРЪЖЕН СЪД/ЧАСТЕН СЪДЕБЕН ИЗПЪЛНИТЕЛ/ОБЯВЯВАНЕ НА)
 * sit in variously-suffixed "label__group[--double|--horizontal]" wrappers —
 * matched by substring since only the base class is shared.
 */
export function parseListPage(html: string): ListItem[] {
  const $ = load(html)
  const items: ListItem[] = []

  $('.item__group').each((_i, el) => {
    const $el = $(el)
    const href = $el.find('.col--image a').first().attr('href')
    const externalId = href?.match(/\/properties\/(\d+)/)?.[1]
    if (!externalId || !href) return

    const facts = new Map<string, string>()
    $el.find('[class*="label__group"]').each((_j, group) => {
      const $group = $(group)
      const label = clean($group.find('.label').first().text())
      const info = clean($group.find('.info').first().text())
      if (label && info && !facts.has(label)) facts.set(label, info)
    })

    const imgSrc = $el.find('.col--image img').first().attr('src')
    const thumbnailUrl = imgSrc && !imgSrc.includes('photo-placeholder') ? absoluteUrl(imgSrc) : null

    items.push({
      externalId,
      title: clean($el.find('.title').first().text()),
      areaText: clean($el.find('.category').first().text()),
      priceText: clean($el.find('.price').first().text()),
      settlement: facts.get('НАСЕЛЕНО МЯСТО') ?? null,
      street: facts.get('Адрес') ?? null,
      courtDistrict: facts.get('ОКРЪЖЕН СЪД') ?? null,
      authority: facts.get('ЧАСТЕН СЪДЕБЕН ИЗПЪЛНИТЕЛ') ?? null,
      announcedAtText: facts.get('ОБЯВЯВАНЕ НА') ?? null,
      thumbnailUrl,
      detailUrl: absoluteUrl(href),
    })
  })

  return items
}

export function mapItem(item: ListItem, platformId: string): Auction {
  const price = parsePrice(item.priceText)
  const areaSqm = parseAreaSqm(item.areaText)
  const land = isLandTitle(item.title)
  const { iso: auctionDateIso, label: auctionDateText } = parseDateTime(item.announcedAtText)

  return {
    platform: platformId,
    country: COUNTRY,
    region: item.courtDistrict ?? '',
    externalId: item.externalId,
    // The chamber portal never publishes the enforcement case's own court
    // file number, only the bailiff's own registration number (detail-page
    // only, not case-specific) — same "no case number to publish" situation
    // as bg/zapori and dga-ag.
    caseNumber: '',
    authority: item.authority ?? '',
    title: item.title,
    address: buildAddress(item.settlement, item.street),
    marketValueEur: price,
    marketValueText: formatPrice(price),
    // "Начална цена" (starting price) opens the bidding and doubles as the
    // reserve — same convention as si/fi/hu/pl/boe/bg.
    startingBid: price,
    sourceLivingAreaSqm: land ? null : areaSqm,
    sourceLandAreaSqm: land ? areaSqm : null,
    sourceRooms: parseRoomCount(item.title),
    auctionDateIso,
    auctionDateText,
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

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const auctions: Auction[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchListPage(page)
    const items = parseListPage(html)
    if (items.length === 0) break
    auctions.push(
      ...items.filter((item) => !isNonPropertyTitle(item.title)).map((item) => mapItem(item, platformId)),
    )
  }
  return { auctions, total: auctions.length }
}
