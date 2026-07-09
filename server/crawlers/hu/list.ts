import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { HU_BASE, LIST_PATH, COUNTRY, UA } from './constants'
import { decodeIso8859_2, parseMnvDate, parseMnvPrice, clean } from './text'
import { getRates, toEur } from '~/server/utils/exchange-rate'

/**
 * Column layout of the MNV property auction table (0-indexed):
 *   0  thumbnail image
 *   1  property type link  (objekt)
 *   2  auction ID text     (zvgId / aktenzeichen)
 *   3  address link        (adresse)
 *   4  ownership share     (skipped)
 *   5  pre-emption right   (checkbox, skipped)
 *   6  reserve price HUF   (verkehrswert)
 *   7  deposit             (skipped)
 *   8  registration deadline (may be empty, skipped)
 *   9  bidding start       (skipped)
 *  10  bidding end         (terminIso / terminText)
 */

interface PageResult {
  auctions: Auction[]
  /** Relative path to next page, e.g. "/index-...?...&currentPage=1". Null on last page. */
  nextPagePath: string | null
  /** Total count reported in pagination text, e.g. 131. Only present on page 1. */
  totalReported: number | null
}

function parsePage(html: string, platformId: string, rates: Record<string, number>): PageResult {
  const $ = load(html)
  const auctions: Auction[] = []

  $('img.colAuctionImage').closest('tr').each((_, row) => {
    const tds = $(row).find('td')
    if (tds.length < 11) return

    const imgSrc = tds.eq(0).find('img').attr('src') ?? null
    const thumbnailUrl = imgSrc ? `${HU_BASE}/${imgSrc}` : null

    // Detail link lives in td[1]; extract numeric auctionId from href
    const href = tds.eq(1).find('a').attr('href') ?? ''
    const auctionIdMatch = href.match(/auctionId=(\d+)/)
    const auctionId = auctionIdMatch?.[1] ?? null
    if (!auctionId) return

    const objekt = clean(tds.eq(1).find('a').text()) || null
    // The visible ID text (e.g. "49866/260702") contains a slash and can't be
    // used as a URL path segment or cache key; use the numeric auctionId as the
    // stable id and keep the slashed text as the human-readable Aktenzeichen.
    const aktenzeichen = clean(tds.eq(2).text()) || auctionId
    const adresseRaw = clean(tds.eq(3).find('a').text() || tds.eq(3).text())
    const priceRaw = clean(tds.eq(6).text())
    const terminRaw = clean(tds.eq(10).text())

    const detailUrl = `${HU_BASE}/index-meghirdetesek-ingatlan.html?.actionId=action.auction.AuctionSummaryAction&auctionId=${auctionId}`

    const huf = parseMnvPrice(priceRaw)

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: '',
      zvgId: auctionId,
      aktenzeichen,
      amtsgericht: '',
      objekt,
      adresse: adresseRaw ? `${adresseRaw}, Ungarn` : null,
      verkehrswertEur: huf != null ? toEur(huf, 'HUF', rates) : null,
      verkehrswertText: huf != null ? `${huf.toLocaleString('de-DE', { maximumFractionDigits: 0 })} Ft` : null,
      terminIso: parseMnvDate(terminRaw),
      terminText: terminRaw || null,
      aufgehoben: false,
      letzteAktualisierungIso: null,
      pdfUrl: null,
      detailUrl,
      pdfUrlUpstream: null,
      detailUrlUpstream: detailUrl,
      attachments: [],
      beschreibung: null,
      fotoCount: thumbnailUrl ? 1 : 0,
      thumbnailUrl,
    })
  })

  // "Következő oldal >" link — href is relative, always contains &currentPage=N
  // On intermediate pages both "Előző oldal" and "Következő oldal" are present;
  // the next-page link contains glDelta=1.
  let nextPagePath: string | null = null
  $('a[href*="glDelta=1"]').each((_, el) => {
    const h = $(el).attr('href')
    if (h && h.includes('currentPage')) nextPagePath = h
  })

  // "1.-30. (131) elem megjelenítve" → 131
  const totalMatch = html.match(/\((\d+)\)\s+elem\s+megjelen/)
  const totalReported = totalMatch?.[1] != null ? parseInt(totalMatch[1], 10) : null

  return { auctions, nextPagePath, totalReported }
}

export async function fetchAllListings(platformId: string): Promise<{ auctions: Auction[]; total: number | null }> {
  const rates = await getRates()
  const allAuctions: Auction[] = []
  let totalReported: number | null = null

  let nextUrl: string | null = `${HU_BASE}${LIST_PATH}`
  // Forward session cookies so the Java framework can track pagination state
  let cookies = ''
  const MAX_PAGES = 50
  let pageCount = 0

  while (nextUrl && pageCount++ < MAX_PAGES) {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'hu,de;q=0.9',
    }
    if (cookies) headers['Cookie'] = cookies

    const res = await fetch(nextUrl, { headers })
    if (!res.ok) throw new Error(`MNV fetch failed: ${res.status} ${nextUrl}`)

    // Maintain session cookies for subsequent pagination requests
    const setCookieHeaders = res.headers.getSetCookie()
    if (setCookieHeaders.length > 0) {
      const jar = new Map<string, string>(
        cookies.split('; ').filter(Boolean).map((c) => {
          const eq = c.indexOf('=')
          return [c.slice(0, eq), c.slice(eq + 1)] as [string, string]
        }),
      )
      for (const entry of setCookieHeaders) {
        const pair = (entry.split(';')[0] ?? '').trim()
        const eq = pair.indexOf('=')
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    }

    // MNV serves ISO-8859-2 — decode explicitly to preserve Hungarian characters
    const html = decodeIso8859_2(await res.arrayBuffer())

    const result = parsePage(html, platformId, rates)
    allAuctions.push(...result.auctions)
    if (result.totalReported != null) totalReported = result.totalReported
    nextUrl = result.nextPagePath ? `${HU_BASE}${result.nextPagePath}` : null
  }

  return { auctions: allAuctions, total: totalReported }
}
