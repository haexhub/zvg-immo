import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { FR_BASE, FR_LIST_REGIONS, UA, COUNTRY, DISALLOWED_DATA_PATHS } from './constants'

const DETAIL_CONCURRENCY = 4
const DEFAULT_LIMIT = 5

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(href: string): string {
  return href.startsWith('http') ? href : `${FR_BASE}${href.startsWith('/') ? '' : '/'}${href}`
}

function idFromHref(href: string): string {
  return href.match(/\/(\d+)\.html/)?.[1] ?? href
}

/** French amounts are formatted like "750 000 €" (space as thousands
 *  separator, sometimes a non-breaking space). */
function parseEurAmount(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(/([\d\s .]+)\s*€/)
  if (!m) return null
  const n = Number(m[1]!.replace(/[\s .]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

interface ListItem {
  href: string
  city: string | null
  title: string | null
  descSnippet: string | null
  priceEur: number | null
  priceText: string | null
}

interface ListPage {
  items: ListItem[]
  total: number | null
  limit: number
}

const FETCH_RETRIES = 2

/** Retries transient failures (timeout, network error, 5xx) so a single blip
 *  doesn't zero out a whole "grande région" until the next crawl cycle. 4xx
 *  responses are not retried — they won't succeed on a second attempt. */
async function htmlFetch(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'fr,en;q=0.9', 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`licitor.com ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`licitor.com ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {}) // drain body to avoid socket leak on retried 5xx
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

function parseListPage(html: string): ListPage {
  const $ = load(html)
  const items: ListItem[] = []

  $('.AdResults > li > a.Ad').each((_i, el) => {
    const $a = $(el)
    const href = $a.attr('href')
    if (!href) return
    const priceText = clean($a.find('.Footer .Price .PriceNumber').first().text()) || null
    items.push({
      href,
      city: clean($a.find('.Location .City').first().text()) || null,
      title: clean($a.find('.Description .Name').first().text()) || null,
      descSnippet: clean($a.find('.Description .Text').first().text()) || null,
      priceEur: parseEurAmount(priceText),
      priceText,
    })
  })

  const total = Number($('input[name="total"]').first().attr('value'))
  const limit = Number($('input[name="limit"]').first().attr('value'))

  return {
    items,
    total: Number.isFinite(total) ? total : null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
  }
}

/** Discovers every listing nationwide by paginating each of the 6 "grande
 *  région" index pages. Pagination doesn't stop by returning an empty page
 *  once past the last one (it clamps to the last valid page instead), so we
 *  must compute the page count from the `total`/`limit` fields up front
 *  rather than looping until empty. */
async function discoverListItems(): Promise<Map<string, ListItem>> {
  const byHref = new Map<string, ListItem>()

  // Isolate failures per region: a transient error on one "grande région"
  // (timeout, HTTP 5xx) must not discard the listings already collected from
  // the others.
  for (const region of FR_LIST_REGIONS) {
    const baseUrl = `${FR_BASE}/ventes-aux-encheres-immobilieres/${region}/prochaines-ventes.html`
    try {
      const firstPage = parseListPage(await htmlFetch(baseUrl))
      for (const item of firstPage.items) byHref.set(item.href, item)

      const totalPages = firstPage.total != null ? Math.ceil(firstPage.total / firstPage.limit) : 1
      for (let page = 2; page <= totalPages; page++) {
        const page_ = parseListPage(await htmlFetch(`${baseUrl}?p=${page}`))
        for (const item of page_.items) byHref.set(item.href, item)
      }
    } catch (err) {
      console.error(`licitor.com: failed to fetch region "${region}"`, err)
    }
  }

  return byHref
}

interface DetailInfo {
  externalId: string
  authority: string | null
  auctionDateIso: string | null
  auctionDateText: string | null
  title: string | null
  description: string | null
  marketValueEur: number | null
  marketValueText: string | null
  address: string | null
  photos: string[]
}

function parseDetailPage(html: string, href: string): DetailInfo {
  const $ = load(html)
  const externalId = clean($('.AdContent .Number').first().text()) || idFromHref(href)
  const authority = clean($('.AdContent .Court').first().text()) || null

  const $time = $('.AdContent .Date time').first()
  const auctionDateIso = $time.attr('datetime') ?? null
  const auctionDateText = clean($time.text()) || null

  const lots = $('.AddressBlock .Lot > div[class*="SousLot"]')
  const titles: string[] = []
  const lotTexts: string[] = []
  lots.each((_i, el) => {
    const $lot = $(el)
    const title = clean($lot.find('h2').first().text())
    if (title) titles.push(title)
    $lot.find('br').replaceWith(' ')
    const desc = clean($lot.find('p').text())
    lotTexts.push([title, desc].filter(Boolean).join(' — '))
  })

  const priceTexts: string[] = []
  let marketValueEur: number | null = null
  $('.AddressBlock .Lot h3').each((_i, el) => {
    const text = clean($(el).text())
    if (!text) return
    priceTexts.push(text)
    const amount = parseEurAmount(text)
    if (amount != null) marketValueEur = (marketValueEur ?? 0) + amount
  })

  const visits = clean($('.AddressBlock .Visits').first().text()) || null
  const description = [...lotTexts, visits].filter(Boolean).join('\n') || null

  const city = clean($('.Location .City').first().text()) || null
  const $street = $('.Location .Street').first()
  $street.find('br').replaceWith(', ')
  const street = clean($street.text()) || null
  const address = [street, city].filter(Boolean).join(', ') || null

  const photos = $('.Pictures a[rel^="lightbox"]')
    .map((_i, el) => $(el).attr('href'))
    .get()
    .filter((href): href is string => Boolean(href))
    .map(absoluteUrl)
    // Enforce the robots.txt boundary: never surface an asset from a
    // disallowed path, even if a future selector change matches one.
    .filter((url) => !DISALLOWED_DATA_PATHS.some((p) => url.includes(p)))

  return {
    externalId,
    authority,
    auctionDateIso,
    auctionDateText,
    title: titles.join('; ') || null,
    description,
    marketValueEur,
    marketValueText: priceTexts.join('; ') || null,
    address,
    photos,
  }
}

async function fetchDetail(href: string): Promise<DetailInfo | null> {
  const url = new URL(absoluteUrl(href))
  if (url.origin !== new URL(FR_BASE).origin) {
    throw new Error(`Unexpected detail URL origin: ${url.origin}`)
  }
  try {
    return parseDetailPage(await htmlFetch(url.toString()), href)
  } catch {
    return null
  }
}

function mapItem(item: ListItem, detail: DetailInfo | null, platformId: string): Auction {
  const externalId = detail?.externalId ?? idFromHref(item.href)
  const detailUrl = absoluteUrl(item.href)
  const photos = detail?.photos ?? []
  const attachments: Attachment[] = []

  return {
    platform: platformId,
    country: COUNTRY,
    // Licitor exposes no sub-regions; the "grande région" split is internal
    // paging only. Empty string per the Auction.region contract (a code like
    // 'all' would render as a literal badge in the UI).
    region: '',
    externalId,
    // Licitor never publishes the court's own case number (no "RG n°" /
    // "répertoire général" anywhere on listing or detail pages) — the visible
    // "Annonce n°" is Licitor's own internal ad id, not a court reference, so
    // it must not be used as caseNumber (see PR #53 review lesson).
    caseNumber: '',
    authority: detail?.authority ?? 'Licitor',
    title: detail?.title ?? item.title,
    address: detail?.address ?? item.city,
    marketValueEur: detail?.marketValueEur ?? item.priceEur,
    marketValueText: detail?.marketValueText ?? item.priceText,
    auctionDateIso: detail?.auctionDateIso ?? null,
    auctionDateText: detail?.auctionDateText ?? null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: detailUrl,
    attachments,
    description: detail?.description ?? item.descSnippet,
    photoCount: photos.length,
    thumbnailUrl: photos[0] ?? null,
    ...(photos.length > 0 ? { photoUrls: photos } : {}),
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const byHref = await discoverListItems()
  const entries = [...byHref.entries()]
  if (entries.length === 0) return { auctions: [], total: 0 }

  const details: (DetailInfo | null)[] = new Array(entries.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < entries.length) {
      const i = cursor++
      const entry = entries[i]
      if (!entry) continue
      details[i] = await fetchDetail(entry[0])
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions = entries.map(([, item], i) => mapItem(item, details[i] ?? null, platformId))
  return { auctions, total: auctions.length }
}
