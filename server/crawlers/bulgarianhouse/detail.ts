import { load, type CheerioAPI } from 'cheerio'
import type { Auction } from '~/types/auction'
import { fetchPageHtml } from './fetch'
import { absoluteUrl, clean, parseLocation, parseNumber } from './text'

/**
 * The "Property Features" quick-facts list ("Location: ...", "Area : ...",
 * "Garden: ...", "Ref. No.: ...") shares its own ".features" class with an
 * unrelated "Nearest Airport" list further down the same column (verified
 * live) — scoping by the preceding heading, not just the first ".features" on
 * the page, is the same defensive lookup kip/detail.ts uses for its
 * heading-keyed info boxes, after bcpea.org's detail page taught this project
 * that a page-wide selector silently mixes in an unrelated block.
 */
function featuresList($: CheerioAPI) {
  const heading = $('h2')
    .filter((_i, el) => $(el).text().trim() === 'Property Features')
    .first()
  return heading.length ? heading.nextAll('ul.features').first() : $()
}

function propertyFeatures($: CheerioAPI): Map<string, string> {
  const facts = new Map<string, string>()
  featuresList($)
    .find('> li')
    .each((_i, el) => {
      const text = clean($(el).text())
      const match = text.match(/^([^:]+):\s*(.*)$/)
      if (match) facts.set(match[1]!.trim(), match[2]!.trim())
    })
  return facts
}

/** The features list opens with the listing's own status badge — AVAILABLE,
 *  SOLD or RESERVED (all three verified live). Returns null when no status
 *  item is there at all, so that a markup change cannot silently un-cancel
 *  the SOLD listings list.ts already flagged from the card badge: "status not
 *  found" must not read as "available". RESERVED (deposit paid, sale not
 *  closed) counts as still available, matching the card-side `.sold`-only
 *  check in list.ts. */
function soldFromDetail($: CheerioAPI): boolean | null {
  const status = featuresList($).find('> li.sold, > li.available, > li.reserved').first()
  if (!status.length) return null
  return status.hasClass('sold')
}

/** Reads the EUR price from its own `itemprop="price"` span, identified via
 *  the `<meta content="EUR" itemprop="priceCurrency">` that immediately
 *  precedes it (the same template always lists EUR before BGN, verified
 *  live, but locating it by the currency meta rather than "the first price
 *  span" avoids relying on that order holding for every listing). */
function extractEurPrice($: CheerioAPI): { value: number; text: string } | null {
  const eurMeta = $('meta[itemprop="priceCurrency"][content="EUR"]').first()
  if (!eurMeta.length) return null
  const span = eurMeta.nextAll('span[itemprop="price"]').first()
  const value = parseNumber(span.attr('content'))
  if (value == null) return null
  return { value, text: clean(span.text()) }
}

/** Replaces every "<br>" with a space before reading .text(), so two
 *  sentences joined only by a line break don't run together — same
 *  clone-then-replace convention as kip/detail.ts's sectionText. */
function extractDescription($: CheerioAPI): string | null {
  const box = $('div[itemprop="description"]').first()
  if (!box.length) return null
  const content = box.clone()
  content.find('br').replaceWith(' ')
  return clean(content.text()) || null
}

/** The gallery markup is duplicated for a lightbox list and a slider
 *  (verified live: every URL appears twice) — deduped via Set, same
 *  convention as kip/detail.ts and dga-ag/detail.ts. */
function extractPhotoUrls($: CheerioAPI): string[] {
  const srcs = $('a.fancybox[href]')
    .map((_i, el) => $(el).attr('href'))
    .get()
    .filter((href): href is string => Boolean(href))
    .map(absoluteUrl)
  return [...new Set(srcs)]
}

export async function enrichOne(auction: Auction): Promise<void> {
  const url = auction.detailUrlUpstream ?? auction.detailUrl
  if (!url) return
  const $ = load(await fetchPageHtml(url, 'detail'))

  if (!auction.title) {
    const h1 = clean($('h1[itemprop="name"]').first().text())
    if (h1) auction.title = h1
  }

  const sold = soldFromDetail($)
  if (sold != null) auction.cancelled = sold

  const facts = propertyFeatures($)
  const location = facts.get('Location')
  const parsed = location ? parseLocation(location) : null
  if (parsed) {
    auction.address = parsed.town === parsed.oblast ? parsed.oblast : `${parsed.town}, ${parsed.oblast}`
    auction.region = parsed.oblast
  }

  const livingAreaSqm = parseNumber(facts.get('Area'))
  if (livingAreaSqm != null) auction.sourceLivingAreaSqm = livingAreaSqm
  const landAreaSqm = parseNumber(facts.get('Garden'))
  if (landAreaSqm != null) auction.sourceLandAreaSqm = landAreaSqm

  const price = extractEurPrice($)
  if (price) {
    auction.marketValueEur = price.value
    auction.marketValueText = price.text
  }

  auction.description = extractDescription($)

  const photoUrls = extractPhotoUrls($)
  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
    auction.thumbnailUrl = auction.thumbnailUrl ?? photoUrls[0] ?? null
  }
}
