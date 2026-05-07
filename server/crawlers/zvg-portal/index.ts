import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { ZVG_BASE, UA, DE_REGIONS, DE_REGION_NAMES, COUNTRY } from './constants'
import { parseAuctionsHtml, buildSearchBody } from './list'
import { enrichInBatches } from './detail'

const PLATFORM_ID = 'zvg-portal'

async function fetchListHtml(landAbk: string, immobilienOnly: boolean): Promise<string> {
  const body = buildSearchBody(landAbk, immobilienOnly)
  // Single-shot: all=1 returns the full list in one response.
  const res = await fetch(`${ZVG_BASE}/index.php?button=Suchen&all=1`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-DE,de;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${ZVG_BASE}/index.php?button=Termine+suchen`,
    },
    body,
  })
  if (!res.ok) throw new Error(`ZVG ${res.status} for ${landAbk}`)
  // The page declares ISO-8859-1 in <meta>, but the HTTP Content-Type header
  // and actual bytes are UTF-8. Trust the header.
  return await res.text()
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const landAbk = opts.region.toLowerCase()
  const immobilienOnly = opts.immobilienOnly ?? true
  const enrichDetails = opts.enrichDetails ?? true

  const html = await fetchListHtml(landAbk, immobilienOnly)
  const { totalReported, auctions } = parseAuctionsHtml(html, landAbk, PLATFORM_ID)

  if (enrichDetails) {
    await enrichInBatches(auctions, landAbk, (auction, info) => {
      auction.attachments = info.attachments
      auction.beschreibung = info.beschreibung
      const fotos = info.attachments.filter((a) => a.kind === 'foto')
      auction.fotoCount = fotos.length
      const firstFoto = fotos[0]
      if (firstFoto) {
        auction.thumbnailUrl = `/api/zvg-thumb?file_id=${firstFoto.fileId}&zvg_id=${auction.zvgId}&land_abk=${landAbk}`
      }
    })
  }

  return {
    platform: PLATFORM_ID,
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
}
