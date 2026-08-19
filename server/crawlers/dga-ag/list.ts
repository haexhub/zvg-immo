import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { AUCTION_HOUSE_LABELS, BASE_URL, COUNTRY, DGA_REGION_NAMES, DGA_REGIONS, LIST_URL, PLATFORM_ID, UA } from './constants'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2
const CACHE_TTL_MS = 5 * 60_000

const REGION_CODE_BY_NAME = new Map(DGA_REGIONS.map((r) => [r.name, r.code]))

function clean(text: string): string {
  return text.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
}

function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

/** Same retry-on-5xx/network-error convention as gb/list.ts and others — 4xx
 *  responses are not retried since a second attempt won't succeed. */
async function fetchListHtml(): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(LIST_URL, {
        headers: { Accept: 'text/html', 'Accept-Language': 'de-DE,de;q=0.9', 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`dga-ag.de list HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`dga-ag.de list HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

export interface ListItem {
  externalId: string
  houseCode: string
  titleHint: string | null
  street: string | null
  cityLine: string | null
  regionCode: string
  lat: number | null
  lng: number | null
  auktionslimit: number | null
  auktionslimitText: string | null
  thumbnailUrl: string | null
  detailUrl: string
}

/**
 * All ~250 current + Nachverkauf objects are rendered server-side on this one
 * page; a client-side "jplist" library only filters/sorts/paginates what's
 * already in the DOM. There is no server-side pagination to follow.
 */
export function parseListPage(html: string): ListItem[] {
  const $ = load(html)
  const items: ListItem[] = []

  $('.tx_goauktion_block').each((_i, el) => {
    const $el = $(el)
    const codeEl = $el.find('.katalogpos p').first()
    const externalId = clean(codeEl.text())
    if (!externalId) return
    const houseCode = (codeEl.attr('class') ?? '').trim().split(/\s+/).pop()?.toLowerCase() ?? ''

    const detailHref = $el.find('.katalogpos a').first().attr('href')
    if (!detailHref) return
    const detailUrl = absoluteUrl(detailHref)

    const addrAnchor = $el.find('.d-col.objekt .addr-list a').first()
    const lines = (addrAnchor.html() ?? '')
      .split(/<br\s*\/?>/i)
      .map((line) => clean(line.replace(/<[^>]+>/g, '')))
      .filter(Boolean)
    const cityLine = lines.find((line) => /^\d{5}\b/.test(line)) ?? lines.at(-1) ?? null
    const cityIdx = cityLine ? lines.indexOf(cityLine) : -1
    const street = cityIdx > 0 ? lines[cityIdx - 1] ?? null : null
    const titleHint = cityIdx > 0 ? lines.slice(0, cityIdx - 1).join(', ') || null : null

    // The Bundesland marker is a hidden <span> whose class is the German
    // state name itself and carries no text — scan every hidden span in the
    // block (there's also an unrelated one for the sortable price) and keep
    // whichever class matches a known region name.
    let regionCode = ''
    $el.find('span[style*="display:none"]').each((_j, span) => {
      const code = REGION_CODE_BY_NAME.get(clean($(span).attr('class') ?? ''))
      if (code) regionCode = code
    })

    const mapAnchor = $el.find('.ortIco a').first()
    const lat = Number(mapAnchor.attr('data-lat'))
    const lng = Number(mapAnchor.attr('data-lon'))

    const limitRaw = clean($el.find('.auktion_limit.price .auktionLimitAmoutForSorting').first().text())
    const limitNum = limitRaw ? Number(limitRaw) : NaN
    const limitText = clean($el.find('.auktion_limit.price p').first().text())

    const thumbSrc = $el.find('.image-block img').first().attr('src')

    items.push({
      externalId,
      houseCode,
      titleHint,
      street,
      cityLine,
      regionCode,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      auktionslimit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : null,
      auktionslimitText: limitText ? `${limitText} €` : null,
      thumbnailUrl: thumbSrc ? absoluteUrl(thumbSrc) : null,
      detailUrl,
    })
  })

  return items
}

export function mapItem(item: ListItem): Auction {
  const authority = AUCTION_HOUSE_LABELS[item.houseCode] ?? 'DGA AG'
  const address = [item.street, item.cityLine].filter(Boolean).join(', ') || null

  return {
    platform: PLATFORM_ID,
    country: COUNTRY,
    region: item.regionCode ? DGA_REGION_NAMES[item.regionCode] ?? '' : '',
    externalId: item.externalId,
    // A private auction-house federation, not a court/government registry —
    // same "no case number to publish" situation as gb/auctionhouse.
    caseNumber: '',
    authority,
    title: item.titleHint,
    address,
    marketValueEur: item.auktionslimit,
    marketValueText: item.auktionslimitText,
    // "Auktionslimit" is the seller's minimum acceptable bid, not a
    // court-appraised Verkehrswert — same dual-assignment as bg/list.ts: it
    // doubles as the display price until/unless a richer figure surfaces.
    startingBid: item.auktionslimit,
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
    lat: item.lat,
    lng: item.lng,
  }
}

let cache: { at: number; auctions: Auction[] } | null = null
let inFlight: Promise<Auction[]> | null = null

/**
 * A full crawl cycle asks this adapter for every registered Bundesland
 * separately (crawlAll iterates {country, region} pairs), but the upstream
 * site has no server-side region filter — every call would otherwise
 * re-fetch and re-parse the same ~90 KB page. A short-lived in-process cache
 * makes one fetch serve the whole cycle.
 */
async function loadAllAuctions(): Promise<Auction[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.auctions
  if (inFlight) return inFlight
  inFlight = (async () => {
    const html = await fetchListHtml()
    const auctions = parseListPage(html).map(mapItem)
    cache = { at: Date.now(), auctions }
    return auctions
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

export async function fetchAllListings(): Promise<{ auctions: Auction[]; total: number }> {
  const auctions = await loadAllAuctions()
  return { auctions, total: auctions.length }
}
