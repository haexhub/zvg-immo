import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { SITEMAP_URL, COUNTRY, UA, DETAIL_CONCURRENCY } from './constants'
import { clean, formatGrPrice, parseGrDateTime, parseGrPrice } from './text'

const FETCH_RETRIES = 2

/** Retries transient failures (timeout, network error, 5xx) so a blip on one
 *  of the ~7.5k detail fetches doesn't drop that lot for a whole 12h cycle.
 *  4xx responses are not retried — they won't succeed on a second attempt. */
async function htmlFetch(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'el,en;q=0.9', 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`eauction24.gr ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`eauction24.gr ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {}) // drain body to avoid socket leak on retried 5xx
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

/** auctions.xml enumerates every currently active lot (the site's own listing
 *  page reports the same count as this sitemap's size); listings.xml is a
 *  different, ordinary for-sale property feed (/listing/…) and must stay
 *  untouched. */
async function fetchAuctionUrls(): Promise<string[]> {
  const xml = await htmlFetch(SITEMAP_URL)
  const urls = [...xml.matchAll(/<loc>(https:\/\/eauction24\.gr\/auction\/\d+)<\/loc>/g)].map(
    (m) => m[1]!,
  )
  return [...new Set(urls)]
}

function idFromUrl(url: string): string | null {
  return url.match(/\/auction\/(\d+)/)?.[1] ?? null
}

interface RealEstateListingLd {
  '@type'?: string
  name?: string
  description?: string
  identifier?: number | string
  image?: unknown
  mainEntity?: {
    address?: {
      streetAddress?: string
      addressLocality?: string
      addressRegion?: string
    }
  }
  offers?: {
    price?: number
  }
}

/** The listing's schema.org JSON-LD carries every structured field we need
 *  (address, price, description) far more reliably than scraping the
 *  Bootstrap markup — only the auction date/time has no schema.org property
 *  and is scraped separately from the `.auction-date` widget below. */
function extractRealEstateLd($: ReturnType<typeof load>): RealEstateListingLd | null {
  let found: RealEstateListingLd | null = null
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return
    try {
      const data = JSON.parse($(el).contents().text()) as RealEstateListingLd
      if (data['@type'] === 'RealEstateListing') found = data
    } catch {
      // malformed JSON-LD block — skip, other scripts on the page may still match
    }
  })
  return found
}

function mapDetail(url: string, html: string, platformId: string): Auction | null {
  const id = idFromUrl(url)
  if (!id) return null

  const $ = load(html)
  const ld = extractRealEstateLd($)
  if (!ld) return null

  const address = ld.mainEntity?.address
  const adresse =
    clean(address?.streetAddress) ??
    clean([address?.addressLocality, address?.addressRegion].filter(Boolean).join(', '))
  const region = clean(address?.addressRegion) ?? ''

  const dateRaw = clean($('.auction-date strong').first().text())
  const { iso: terminIso, label: terminText } = parseGrDateTime(dateRaw)

  // "Η ημερομηνία πλειστηριασμού έχει παρέλθει" ("the auction date has
  // passed") is shown on lots still linked from the sitemap after their date
  // elapsed without being taken down — the closest signal to "no longer an
  // active auction" this source exposes.
  const aufgehoben = /έχει παρέλθει/.test($.text())

  const verkehrswertEur = parseGrPrice(
    typeof ld.offers?.price === 'number' ? ld.offers.price : null,
  )

  const photoUrls = [
    ...new Set(
      (Array.isArray(ld.image) ? ld.image : typeof ld.image === 'string' ? [ld.image] : []).filter(
        (src): src is string => typeof src === 'string',
      ),
    ),
  ]

  return {
    platform: platformId,
    country: COUNTRY,
    region,
    zvgId: id,
    // eauction24.gr never publishes the notary/officer's own case number or
    // court/notary name.
    aktenzeichen: '',
    amtsgericht: '',
    objekt: clean(ld.name),
    adresse,
    verkehrswertEur,
    verkehrswertText: formatGrPrice(verkehrswertEur),
    terminIso,
    terminText,
    aufgehoben,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: url,
    pdfUrlUpstream: null,
    detailUrlUpstream: url,
    attachments: [],
    beschreibung: clean(ld.description),
    fotoCount: photoUrls.length,
    thumbnailUrl: photoUrls[0] ?? null,
    photoUrls,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const urls = await fetchAuctionUrls()
  if (urls.length === 0) return { auctions: [], total: 0 }

  const auctions: (Auction | null)[] = new Array(urls.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++
      const url = urls[i]
      if (!url) continue
      try {
        auctions[i] = mapDetail(url, await htmlFetch(url), platformId)
      } catch {
        auctions[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const result = auctions.filter((a): a is Auction => a !== null)
  return { auctions: result, total: result.length }
}
