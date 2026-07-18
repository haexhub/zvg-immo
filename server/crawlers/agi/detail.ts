import * as cheerio from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import type { PropertyType } from '~/lib/property-type'
import { AGI_BASE, UA } from './constants'
import { allegatoKind, parseItNumber } from './text'
import { areaBucketForPropertyType } from '~/server/utils/extract/rules'

interface DetailInfo {
  attachments: Attachment[]
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  photoCount: number
  thumbnailUrl: string | null
  photoUrls: string[]
  livingAreaSqm: number | null
  landAreaSqm: number | null
  /** "Metri quadri" whose bene category is neither clearly residential nor
   *  plain land — surfaced as a labeled note in the description instead of a
   *  structured field, so the extraction pipeline can still classify it. */
  unclassifiedAreaSqm: number | null
  rooms: number | null
}

/** Bene categories (p.titoloBene, e.g. "Appartamento", "Terreno") that map the
 *  bene's "Metri quadri" unambiguously to living resp. land area. Everything
 *  else (commerciale, magazzino, "altra categoria", …) stays unclassified —
 *  conservative, mis-assignment is worse than a miss. */
const RESIDENTIAL_BENE_RE =
  /\b(?:appartament\w*|abitazion\w*|residenzial\w*|villa|villetta|villino|attico|mansard\w*|monolocale|bilocale|trilocale|quadrilocale|casa|casale)\b/i
const LAND_BENE_RE = /\bterren\w*/i

/** Maps a bene categoria to a representative PropertyType for
 *  areaBucketForPropertyType (agi's Italian categoria text isn't covered by
 *  property-type.ts's conservative cross-language regexes). */
function categoriaPropertyType(categoria: string): PropertyType | null {
  if (LAND_BENE_RE.test(categoria)) return 'unbebaut'
  if (RESIDENTIAL_BENE_RE.test(categoria)) return 'eigentumswohnung'
  return null
}

/** Fetch the detail page HTML and extract attachments, photos and bene data. */
async function fetchDetailInfo(detailUpstream: string): Promise<DetailInfo> {
  const res = await fetch(detailUpstream, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`[agi] detail page HTTP ${res.status}: ${detailUpstream}`)
  return parseDetailHtml(await res.text())
}

/** Parse a detail page's HTML. Exported for tests. */
export function parseDetailHtml(html: string): DetailInfo {
  const $ = cheerio.load(html)

  const attachments: Attachment[] = []
  let pdfUpstream: string | null = null
  const seenPaths = new Set<string>()
  const seenFotoPaths = new Set<string>()
  const photoUrls: string[] = []

  // Collect all /allegato/ hrefs (PDF and image files)
  $('a[href^="/allegato/"]').each((_, el) => {
    const path = $(el).attr('href') ?? ''
    if (seenPaths.has(path)) return

    const filename = path.split('/').find((seg) => seg.includes('.')) ?? path
    const lowerFile = filename.toLowerCase()

    if (lowerFile.endsWith('.pdf')) {
      seenPaths.add(path)
      // A foto-*.pdf is an attachment, not a photo: keep it out of the photo kind
      const kind = allegatoKind(filename) === 'photo' ? 'other' : allegatoKind(filename)
      const upstreamUrl = `${AGI_BASE}${path}`
      attachments.push({
        kind,
        label: $(el).text().trim() || filename,
        filename,
        sizeBytes: null,
        fileId: path,
        proxyUrl: upstreamUrl,
      })
      // Prefer appraisal as primary PDF; fall back to the first PDF found
      if (kind === 'appraisal') {
        pdfUpstream = upstreamUrl
      } else if (!pdfUpstream) {
        pdfUpstream = upstreamUrl
      }
    }
  })

  // Collect gallery photos from /allegato/foto-* img tags (swiper main slides
  // and thumbnails repeat the same path — dedupe); prefer data-src for
  // lazy-loaded images
  $('img[src^="/allegato/foto-"], img[data-src^="/allegato/foto-"]').each((_, el) => {
    const src = $(el).attr('data-src') ?? $(el).attr('src') ?? ''
    if (!src.toLowerCase().includes('/allegato/foto-')) return
    if (!seenFotoPaths.has(src)) {
      seenFotoPaths.add(src)
      photoUrls.push(`${AGI_BASE}${src}`)
    }
  })

  // "Dati dei beni": one div[data-pvp-bene-area] block per bene, each with
  // .dettagliLotto__item cells of the form <strong>Label</strong><br><span>value</span>.
  // Only a single bene is unambiguous — with several beni per lot the values
  // cannot be attributed, so they are skipped.
  let livingAreaSqm: number | null = null
  let landAreaSqm: number | null = null
  let unclassifiedAreaSqm: number | null = null
  let rooms: number | null = null
  const beni = $('[data-pvp-bene-area]')
  if (beni.length === 1) {
    const bene = beni.first()
    const categoria = bene.find('.titoloBene').first().text().trim()
    let areaSqm: number | null = null
    bene.find('.dettagliLotto__item strong').each((_, el) => {
      const label = $(el).text().trim().toLowerCase()
      const value = $(el).parent().text().replace($(el).text(), '').trim()
      if (label === 'metri quadri' || label === 'superficie') {
        areaSqm ??= parseItNumber(value)
      } else if (label === 'vani') {
        rooms ??= parseItNumber(value)
      }
    })
    if (areaSqm != null) {
      const bucket = areaBucketForPropertyType(categoriaPropertyType(categoria))
      if (bucket === 'land') landAreaSqm = areaSqm
      else if (bucket === 'living') livingAreaSqm = areaSqm
      else unclassifiedAreaSqm = areaSqm
    }
  }

  return {
    attachments,
    pdfUrl: pdfUpstream,
    pdfUrlUpstream: pdfUpstream,
    photoCount: photoUrls.length,
    thumbnailUrl: photoUrls[0] ?? null,
    photoUrls,
    livingAreaSqm,
    landAreaSqm,
    unclassifiedAreaSqm,
    rooms,
  }
}

/** Apply parsed detail info to an auction in place. Exported for tests. */
export function applyDetailInfo(auction: Auction, info: DetailInfo): void {
  if (info.attachments.length > 0) auction.attachments = info.attachments
  if (info.pdfUrl) {
    auction.pdfUrl = info.pdfUrl
    auction.pdfUrlUpstream = info.pdfUrlUpstream
  }
  if (info.photoUrls.length > 0) {
    auction.photoUrls = info.photoUrls
    auction.photoCount = info.photoUrls.length
    if (info.thumbnailUrl && !auction.thumbnailUrl) {
      auction.thumbnailUrl = info.thumbnailUrl
    }
  }
  if (info.livingAreaSqm != null) auction.sourceLivingAreaSqm = info.livingAreaSqm
  if (info.landAreaSqm != null) auction.sourceLandAreaSqm = info.landAreaSqm
  if (info.rooms != null) auction.sourceRooms = info.rooms
  if (info.unclassifiedAreaSqm != null) {
    // Not confidently living or land area: surface it as a labeled note so the
    // extraction pipeline (LLM pass) can classify it with full context.
    // "Superficie:" is deliberately not one of the rules-pass labels. The
    // includes-guard keeps repeated enrich runs from stacking the note.
    const note = `Superficie: ${info.unclassifiedAreaSqm} mq`
    if (!auction.description?.includes(note)) {
      auction.description = auction.description
        ? `${auction.description}\n${note}`
        : note
    }
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
        console.warn(`[agi] enrichOne failed for ${auction.externalId}: ${(err as Error).message}`)
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
