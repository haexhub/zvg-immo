import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { ZVG_BASE, UA, DE_REGIONS, DE_REGION_NAMES, COUNTRY } from './constants'
import { parseAuctionsHtml, buildSearchBody } from './list'
import { enrichInBatches, type DetailInfo } from './detail'
import { isZvgErrorBody } from './text'
import { describeFetchError, retryTransient, TransientUpstreamError } from '../transient-retry'

const PLATFORM_ID = 'zvg-portal'

function applyDetail(auction: Auction, info: DetailInfo, landAbk: string): void {
  auction.attachments = info.attachments
  auction.description = info.description
  const photos = info.attachments.filter((a) => a.kind === 'photo')
  auction.photoCount = photos.length
  const firstFoto = photos[0]
  if (firstFoto) {
    auction.thumbnailUrl = `/api/zvg-thumb?file_id=${firstFoto.fileId}&zvg_id=${auction.externalId}&land_abk=${landAbk}`
  }
}

async function enrichOne(auction: Auction): Promise<void> {
  const landAbk = new URLSearchParams((auction.detailUrlUpstream ?? '').split('?')[1] ?? '').get('land_abk')
  // Missing land_abk / non-numeric externalId is permanent — nothing to fetch, ever.
  if (!landAbk || !/^\d+$/.test(auction.externalId)) return
  const r = await enrichInBatches([auction], landAbk, (a, info) => applyDetail(a, info, landAbk))
  if (r.errors > 0) {
    // The enrich task only logs the message, so carry the reason in it too
    // (same as zvbawu/index.ts).
    throw new Error(`zvg-portal detail fetch failed: ${(r.firstError as Error).message}`, { cause: r.firstError })
  }
}

const FETCH_TIMEOUT_MS = 20_000

/** The search is a read-only POST, so a dropped connection, a 5xx or the
 *  portal's bare `error` body under load is retried (retryTransient). */
async function fetchListHtml(landAbk: string, immobilienOnly: boolean): Promise<string> {
  const body = buildSearchBody(landAbk, immobilienOnly)
  try {
    return await retryTransient(async () => {
      // Single-shot: all=1 returns the full list in one response.
      const res = await fetch(`${ZVG_BASE}/index.php?button=Suchen&all=1`, {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'de-DE,de;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${ZVG_BASE}/index.php?button=Termine+suchen`,
        },
        body,
      })
      if (res.status >= 500) throw new TransientUpstreamError(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // The page declares ISO-8859-1 in <meta>, but the HTTP Content-Type header
      // and actual bytes are UTF-8. Trust the header.
      const html = await res.text()
      if (isZvgErrorBody(html)) throw new TransientUpstreamError('returned error page')
      return html
    })
  } catch (err) {
    throw new Error(`ZVG list ${landAbk}: ${describeFetchError(err)}`, { cause: err })
  }
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const landAbk = opts.region.toLowerCase()
  const immobilienOnly = opts.immobilienOnly ?? true
  const enrichDetails = opts.enrichDetails ?? true

  const html = await fetchListHtml(landAbk, immobilienOnly)
  const { totalReported, rowCount, auctions } = parseAuctionsHtml(html, landAbk, PLATFORM_ID)
  // A real result page always says "Insgesamt N", "Insgesamt 0" included
  // (verified live). Without it and without rows this is some other page, and
  // reporting it as an empty Land would expire every listing of that Land.
  if (totalReported == null && auctions.length === 0) {
    throw new Error(`ZVG list ${landAbk}: no "Insgesamt" marker and no rows — not a result page`)
  }
  // Fewer rows than announced means a truncated response: keep what came in,
  // but withhold success so crawl-state.ts does not expire the missing ones.
  const complete = totalReported == null || rowCount >= totalReported
  if (!complete) {
    console.warn(`[zvg-portal] ${landAbk}: ${rowCount} of ${totalReported} announced rows received, reporting incomplete`)
  }

  if (enrichDetails) {
    const result = await enrichInBatches(auctions, landAbk, (auction, info) =>
      applyDetail(auction, info, landAbk),
    )
    if (result.errors > 0) {
      console.warn(
        `[zvg-portal] ${landAbk}: enriched ${result.enriched}/${auctions.length}, ${result.errors} detail fetches failed`,
      )
    }
  }

  return {
    platform: PLATFORM_ID,
    platformsSucceeded: complete ? [PLATFORM_ID] : [],
    source: ZVG_BASE,
    countries: [COUNTRY],
    regions: [DE_REGION_NAMES[landAbk] || landAbk],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions,
  }
}

export const zvgPortalCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Justizportal des Bundes und der Länder',
  baseUrl: ZVG_BASE,
  country: COUNTRY,
  regions: DE_REGIONS,
  crawl,
  enrichOne,
}
