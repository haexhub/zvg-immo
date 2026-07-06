import * as cheerio from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { AGI_BASE, UA } from './constants'
import { allegatoKind } from './text'

interface DetailInfo {
  attachments: Attachment[]
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  fotoCount: number
  thumbnailUrl: string | null
}

/** Fetch the detail page HTML and extract attachments and photo count. */
async function fetchDetailInfo(detailUpstream: string): Promise<DetailInfo> {
  const res = await fetch(detailUpstream, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`[agi] detail page HTTP ${res.status}: ${detailUpstream}`)
  const html = await res.text()
  const $ = cheerio.load(html)

  const attachments: Attachment[] = []
  let pdfUpstream: string | null = null
  const seenPaths = new Set<string>()
  const seenFotoPaths = new Set<string>()
  let fotoCount = 0
  let thumbnailUrl: string | null = null

  // Collect all /allegato/ hrefs (PDF and image files)
  $('a[href^="/allegato/"]').each((_, el) => {
    const path = $(el).attr('href') ?? ''
    if (seenPaths.has(path)) return

    const filename = path.split('/').find((seg) => seg.includes('.')) ?? path
    const lowerFile = filename.toLowerCase()

    if (lowerFile.endsWith('.pdf')) {
      seenPaths.add(path)
      // A foto-*.pdf is an attachment, not a photo: keep it out of the foto kind
      const kind = allegatoKind(filename) === 'foto' ? 'sonstiges' : allegatoKind(filename)
      const upstreamUrl = `${AGI_BASE}${path}`
      attachments.push({
        kind,
        label: $(el).text().trim() || filename,
        filename,
        sizeBytes: null,
        fileId: path,
        proxyUrl: upstreamUrl,
      })
      // Prefer gutachten as primary PDF; fall back to the first PDF found
      if (kind === 'gutachten') {
        pdfUpstream = upstreamUrl
      } else if (!pdfUpstream) {
        pdfUpstream = upstreamUrl
      }
    }
  })

  // Count photo attachments from /allegato/foto-* img tags; prefer data-src for lazy-loaded images
  $('img[src^="/allegato/foto-"], img[data-src^="/allegato/foto-"]').each((_, el) => {
    const src = $(el).attr('data-src') ?? $(el).attr('src') ?? ''
    if (!src.toLowerCase().includes('/allegato/foto-')) return
    if (!seenFotoPaths.has(src)) {
      seenFotoPaths.add(src)
      fotoCount++
      if (!thumbnailUrl) thumbnailUrl = `${AGI_BASE}${src}`
    }
  })

  return {
    attachments,
    pdfUrl: pdfUpstream,
    pdfUrlUpstream: pdfUpstream,
    fotoCount,
    thumbnailUrl,
  }
}

function applyDetailInfo(auction: Auction, info: DetailInfo): void {
  if (info.attachments.length > 0) auction.attachments = info.attachments
  if (info.pdfUrl) {
    auction.pdfUrl = info.pdfUrl
    auction.pdfUrlUpstream = info.pdfUrlUpstream
  }
  auction.fotoCount = info.fotoCount
  if (info.thumbnailUrl && !auction.thumbnailUrl) {
    auction.thumbnailUrl = info.thumbnailUrl
  }
}

export interface EnrichResult {
  enriched: number
  errors: number
}

/** Enrich a batch of auctions with detail-page data (attachments, PDFs). */
export async function enrichInBatches(
  auctions: Auction[],
  concurrency = 5,
): Promise<EnrichResult> {
  let enriched = 0
  let errors = 0
  let cursor = 0

  async function worker() {
    while (cursor < auctions.length) {
      const idx = cursor++
      const auction = auctions[idx]
      if (!auction) continue
      if (!auction.detailUrlUpstream) { enriched++; continue }
      try {
        const info = await fetchDetailInfo(auction.detailUrlUpstream)
        applyDetailInfo(auction, info)
        enriched++
      } catch (err) {
        errors++
        console.warn(`[agi] enrichOne failed for ${auction.zvgId}: ${(err as Error).message}`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  return { enriched, errors }
}

/** Enrich a single auction in place. Used by the enrich task. */
export async function enrichSingle(auction: Auction): Promise<void> {
  if (!auction.detailUrlUpstream) return
  const info = await fetchDetailInfo(auction.detailUrlUpstream)
  applyDetailInfo(auction, info)
}
