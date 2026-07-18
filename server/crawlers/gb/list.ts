import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { GB_BASE, GB_LIST_REGIONS, UA, COUNTRY } from './constants'

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(href: string): string {
  return href.startsWith('http') ? href : `${GB_BASE}${href.startsWith('/') ? '' : '/'}${href}`
}

/** Own-site lot pages (/<region>/auction/lot/<id>) and online.auctionhouse.co.uk
 *  redirect links (/lot/redirect/<id>) both end in a plain numeric id. */
function idFromHref(href: string): string {
  return href.match(/(\d+)(?:[/?]|$)/)?.[1] ?? href
}

/** Guide prices are formatted "£475,000+", "£5,000 - £15,000" or "£500+" —
 *  take the first (lowest) figure as the indicative value, same convention
 *  other crawlers use for a range-only Verkehrswert. */
function parseGbpAmount(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(/£\s*([\d,]+)/)
  if (!m) return null
  const n = Number(m[1]!.replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

interface ListItem {
  href: string
  address: string | null
  title: string | null
  priceGbp: number | null
  priceText: string | null
  thumbnailUrl: string | null
  branchName: string
}

const FETCH_RETRIES = 2

/** Retries transient failures (timeout, network error, 5xx) so a single blip
 *  doesn't zero out a whole branch until the next crawl cycle. 4xx responses
 *  are not retried — they won't succeed on a second attempt. No robots.txt
 *  Crawl-delay is declared for www.auctionhouse.co.uk itself (only
 *  online.auctionhouse.co.uk does, see constants.ts/detail.ts), so listing
 *  pages are fetched one branch at a time without an extra artificial delay. */
async function htmlFetch(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9', 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`auctionhouse.co.uk ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`auctionhouse.co.uk ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {}) // drain body to avoid socket leak on retried 5xx
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}

/** <title>Auction House London | Property Auctioneers in London</title> gives
 *  the branch's display name to attribute a lot to (there's no court, so this
 *  fills the authority slot instead). Falls back to the generic franchise
 *  name for any page whose title doesn't follow that pattern. */
function branchNameFromTitle(html: string): string {
  const m = html.match(/<title>\s*Auction House (.+?)\s*\|/i)
  return m ? `Auction House ${m[1]}` : 'Auction House UK'
}

/** Every branch page (verified live against several regions) renders its
 *  full current lot list on one unpaginated page — no "?page=" links, no
 *  truncated result count — so there is no pagination to follow here. */
export function parseListPage(html: string): ListItem[] {
  const $ = load(html)
  const branchName = branchNameFromTitle(html)
  const items: ListItem[] = []

  $('.lot-search-result a.home-lot-wrapper-link').each((_i, el) => {
    const $a = $(el)
    const href = $a.attr('href')
    if (!href) return
    const priceText = clean($a.find('.grid-view-guide').first().text()) || null
    const imgSrc = $a.find('img.lot-image').first().attr('src')
    items.push({
      href,
      address: clean($a.find('.grid-address').first().text()) || null,
      title: clean($a.find('.summary-info-wrapper p.fw-bold').first().text()) || null,
      priceGbp: parseGbpAmount(priceText),
      priceText,
      thumbnailUrl: imgSrc ? absoluteUrl(imgSrc) : null,
      branchName,
    })
  })

  return items
}

/** Discovers every current lot nationwide by fetching each of the ~30 branch
 *  pages. Isolate failures per branch: a transient error on one region
 *  (timeout, HTTP 5xx) must not discard the listings already collected from
 *  the others. Lots are deduped by href — a lot could in principle be linked
 *  from more than one branch page (e.g. bordering regions), and this also
 *  protects against `discoverListItems` being extended to pull in an
 *  overlapping aggregator page later. */
async function discoverListItems(): Promise<Map<string, ListItem>> {
  const byHref = new Map<string, ListItem>()

  for (const region of GB_LIST_REGIONS) {
    try {
      const items = parseListPage(await htmlFetch(`${GB_BASE}/${region}`))
      for (const item of items) {
        if (!byHref.has(item.href)) byHref.set(item.href, item)
      }
    } catch (err) {
      console.error(`auctionhouse.co.uk: failed to fetch region "${region}"`, err)
    }
  }

  return byHref
}

function mapItem(item: ListItem, platformId: string): Auction {
  const externalId = idFromHref(item.href)
  const detailUrl = absoluteUrl(item.href)

  return {
    platform: platformId,
    country: COUNTRY,
    // Auction House UK exposes no sub-regions a user would filter by — the
    // ~30 branch pages are purely an internal listing split (see
    // GB_LIST_REGIONS in constants.ts), same as Licitor's "grande région".
    region: '',
    externalId,
    // Not a court/government registry — there is no case number to publish.
    // See the caveat in constants.ts: this is a general auction-lots feed,
    // not a pure forced-sale source.
    caseNumber: '',
    authority: item.branchName,
    title: item.title,
    address: item.address,
    marketValueEur: null,
    marketValue: item.priceGbp,
    currency: item.priceGbp != null ? 'GBP' : null,
    marketValueText: item.priceText,
    // Not shown on the list card at all (only on the detail page) — filled
    // in lazily by enrichOne (detail.ts) instead of eagerly fetching every
    // lot's detail page here, which at AH's nationwide lot volume would mean
    // thousands of requests per crawl cycle (see detail.ts for the rationale).
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: detailUrl,
    attachments: [],
    description: null,
    photoCount: item.thumbnailUrl ? 1 : 0,
    thumbnailUrl: item.thumbnailUrl,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const byHref = await discoverListItems()
  const auctions = [...byHref.values()].map((item) => mapItem(item, platformId))
  return { auctions, total: auctions.length }
}
