import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { LT_BASE, UA } from './constants'
import { clean, parseLtArea } from './text'

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
  const detail = parseDetailPage(await res.text())

  if (detail.beschreibung) auction.beschreibung = detail.beschreibung

  // "Bendras turto plotas" is the lot's total area — land area for plots,
  // floor area for flats/premises. Anything else (buildings with unknown
  // land/floor split) only goes into the description text.
  const typeHint = `${detail.potipis ?? ''} ${auction.objekt ?? ''}`
  if (detail.areaSqm != null) {
    if (/sklyp|žem/i.test(typeHint)) {
      auction.sourceLandAreaSqm = detail.areaSqm
    } else if (/but|patalp/i.test(typeHint)) {
      auction.sourceLivingAreaSqm = detail.areaSqm
    } else if (detail.areaRaw) {
      auction.beschreibung = [auction.beschreibung, `Bendras turto plotas: ${detail.areaRaw}`]
        .filter(Boolean)
        .join('\n\n')
    }
  }

  if (detail.photoUrls.length > 0) {
    auction.photoUrls = detail.photoUrls
    auction.fotoCount = detail.photoUrls.length
  }
}
