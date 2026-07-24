import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import type { PropertyType } from '~/lib/property-type'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { LT_BASE, UA } from './constants'
import { clean, parseLtArea } from './text'
import { areaBucketForPropertyType } from '~/server/utils/extract/rules'

/** Maps the potipis/title type hint to a representative PropertyType for
 *  areaBucketForPropertyType (its Lithuanian vocabulary isn't covered by
 *  property-type.ts's conservative cross-language regexes). */
function typeHintPropertyType(typeHint: string): PropertyType | null {
  if (/sklyp|žem/i.test(typeHint)) return 'unbebaut'
  if (/but|patalp/i.test(typeHint)) return 'eigentumswohnung'
  return null
}

export interface LtDetail {
  /** "Aprašymas:" free text, line breaks preserved. */
  beschreibung: string | null
  /** Raw "Bendras turto plotas:" value, e.g. "13 a. (0,13 ha.)". */
  areaRaw: string | null
  areaSqm: number | null
  /** "Turto potipis:" subtype, e.g. "Sklypai" or "Patalpos/Butai". */
  potipis: string | null
  /** Real gallery photos (a.fancybox-gallery). Map placeholder renders
   *  (map/photo.jpg, a.fancybox-map) are excluded. */
  photoUrls: string[]
}

/** Detail rows are <li><span class="left">Label:</span><span class="right">value</span></li>. */
export function parseDetailPage(html: string): LtDetail {
  const $ = load(html)
  let beschreibung: string | null = null
  let areaRaw: string | null = null
  let potipis: string | null = null

  $('li').each((_, li) => {
    const label = clean($(li).find('span.left').first().text())
    if (!label) return
    const right = $(li).find('span.right').first()
    if (label.startsWith('Aprašymas')) {
      beschreibung =
        right
          .text()
          .split('\n')
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('\n') || null
    } else if (label.startsWith('Bendras turto plotas')) {
      areaRaw = clean(right.text()) || null
    } else if (label.startsWith('Turto potipis')) {
      potipis = clean(right.text()) || null
    }
  })

  const photoUrls: string[] = []
  $('a.fancybox-gallery').each((_, a) => {
    const href = $(a).attr('href')
    if (!href || href.includes('map/photo.jpg')) return
    photoUrls.push(href.startsWith('http') ? href : `${LT_BASE}${href}`)
  })

  return {
    beschreibung,
    areaRaw,
    areaSqm: areaRaw ? parseLtArea(areaRaw) : null,
    potipis,
    photoUrls: [...new Set(photoUrls)],
  }
}

export async function enrichOne(auction: Auction): Promise<void> {
  if (!auction.detailUrlUpstream) return
  const res = await fetch(auction.detailUrlUpstream, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'lt,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`eaukcionai.lt detail: HTTP ${res.status}`)
  const html = await res.text()
  await archiveDetailCapture(
    Buffer.from(html, 'utf8'),
    {
      platform: auction.platform,
      country: auction.country,
      region: auction.region,
      externalId: auction.externalId,
      caseNumber: auction.caseNumber,
      authority: auction.authority,
    } satisfies DocumentIdentity,
    auction.detailUrlUpstream,
    new Date().toISOString(),
  )
  const detail = parseDetailPage(html)

  if (detail.beschreibung) auction.description = detail.beschreibung

  // "Bendras turto plotas" is the lot's total area — land area for plots,
  // floor area for flats/premises. Anything else (buildings with unknown
  // land/floor split) only goes into the description text.
  const typeHint = `${detail.potipis ?? ''} ${auction.title ?? ''}`
  if (detail.areaSqm != null) {
    const bucket = areaBucketForPropertyType(typeHintPropertyType(typeHint))
    if (bucket === 'land') {
      auction.sourceLandAreaSqm = detail.areaSqm
    } else if (bucket === 'living') {
      auction.sourceLivingAreaSqm = detail.areaSqm
    } else if (detail.areaRaw) {
      auction.description = [auction.description, `Bendras turto plotas: ${detail.areaRaw}`]
        .filter(Boolean)
        .join('\n\n')
    }
  }

  if (detail.photoUrls.length > 0) {
    auction.photoUrls = detail.photoUrls
    auction.photoCount = detail.photoUrls.length
  }
}
