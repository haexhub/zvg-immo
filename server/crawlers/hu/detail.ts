import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import type { PropertyType } from '~/lib/property-type'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
import type { DocumentIdentity } from '~/server/utils/raw-archive'
import { HU_BASE, UA } from './constants'
import { decodeIso8859_2, parseMnvPrice, clean, htmlToText, jsFieldValue, jsFieldUnit } from './text'
import { areaBucketForPropertyType } from '~/server/utils/extract/rules'

/** Maps the MNV title text to a representative PropertyType for
 *  areaBucketForPropertyType (its Hungarian vocabulary isn't covered by
 *  property-type.ts's conservative cross-language regexes). */
function titlePropertyType(title: string | null): PropertyType | null {
  return title != null && /terület|telek|föld/i.test(title) ? 'unbebaut' : null
}

export interface HuDetail {
  /** "Egyéb infó:" free text (tr#description). */
  description: string | null
  /** "Becsérték:" in HUF — the actual valuation. Absent on most MNV lots,
   *  which only publish the "Kikiáltási ár" (reserve/starting price). */
  becsertekHuf: number | null
  /** Raw "Kikiáltási ár:" cell text, e.g. "3 900 000 HUF". */
  kikialtasiRaw: string | null
  /** "Helyrajzi szám" (cadastral number) from the property sheet JS. */
  helyrajziSzam: string | null
  /** "Terület" (estate_square) in m²; ha values are converted. */
  areaSqm: number | null
  /** Human-readable area, e.g. "9 643 m2". */
  areaRaw: string | null
  photoUrls: string[]
  /** Coordinates from the static-map link (markers= lat, lng). */
  lat: number | null
  lng: number | null
}

export function parseDetailPage(html: string): HuDetail {
  const $ = load(html)

  const descHtml = $('tr#description td').first().html()
  const description = descHtml ? htmlToText(descHtml) || null : null

  let becsertekRaw: string | null = null
  let kikialtasiRaw: string | null = null
  $('th').each((_, th) => {
    const label = clean($(th).text())
    const value = clean($(th).nextAll('td').first().text())
    if (!value) return
    if (label.startsWith('Becsérték')) becsertekRaw ??= value
    if (label === 'Kikiáltási ár:') kikialtasiRaw ??= value
  })

  const photoUrls: string[] = []
  $('img[fullurl]').each((_, img) => {
    const u = $(img).attr('fullurl')
    if (u?.startsWith('pictures/')) photoUrls.push(`${HU_BASE}/${u}`)
  })

  const areaValue = jsFieldValue(html, 'estate_square')
  const areaUnit = jsFieldUnit(html, 'estate_square')
  let areaSqm: number | null = null
  if (areaValue != null) {
    const n = parseFloat(areaValue.replace(/\s/g, '').replace(',', '.'))
    if (Number.isFinite(n) && n > 0) {
      areaSqm = areaUnit === 'ha' ? n * 10_000 : n
    }
  }

  // Tolerate style/label prefixes in the marker param ("markers=color:red|47.5,19.0").
  const coords = html.match(/markers=(?:[^&"'\s]*?[|:])?\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/)

  return {
    description,
    becsertekHuf: becsertekRaw != null ? parseMnvPrice(becsertekRaw) : null,
    kikialtasiRaw,
    helyrajziSzam: jsFieldValue(html, 'place_num'),
    areaSqm,
    areaRaw: areaSqm != null ? `${areaValue} ${areaUnit ?? 'm2'}` : null,
    photoUrls: [...new Set(photoUrls)],
    lat: coords?.[1] != null ? parseFloat(coords[1]) : null,
    lng: coords?.[2] != null ? parseFloat(coords[2]) : null,
  }
}

export async function enrichOne(auction: Auction): Promise<void> {
  if (!auction.detailUrlUpstream) return
  const res = await fetch(auction.detailUrlUpstream, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'hu,de;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`MNV detail: HTTP ${res.status}`)
  const rawBytes = await res.arrayBuffer()
  // Archive the raw ISO-8859-2 bytes as fetched, not the UTF-16 decoded
  // string used for parsing below — keeps the capture byte-identical to the
  // upstream response.
  await archiveDetailCapture(
    Buffer.from(rawBytes),
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
  const html = decodeIso8859_2(rawBytes)
  const d = parseDetailPage(html)

  const lines: string[] = []
  if (d.description) lines.push(d.description)
  if (d.helyrajziSzam) lines.push(`Helyrajzi szám: ${d.helyrajziSzam}`)
  if (d.areaRaw) lines.push(`Terület: ${d.areaRaw}`)

  // The list value ("Kikiáltási ár") is only the starting price. When the lot
  // publishes a real valuation ("Becsérték"), prefer it as marketValue and
  // keep the starting price as a labelled description line.
  if (d.becsertekHuf != null) {
    auction.marketValue = d.becsertekHuf
    auction.currency = 'HUF'
    auction.marketValueText = `${d.becsertekHuf.toLocaleString('de-DE', { maximumFractionDigits: 0 })} Ft`
    if (d.kikialtasiRaw) lines.push(`Kikiáltási ár (Startpreis): ${d.kikialtasiRaw}`)
  }

  if (lines.length > 0) auction.description = lines.join('\n\n')

  // "Terület" is the parcel area from the land register — structured land
  // area for plots; for built-up lots it may mix parcel/floor semantics, so
  // it stays description-only there.
  if (d.areaSqm != null && areaBucketForPropertyType(titlePropertyType(auction.title)) === 'land') {
    auction.sourceLandAreaSqm = d.areaSqm
  }

  if (d.photoUrls.length > 0) {
    auction.photoUrls = d.photoUrls
    auction.photoCount = d.photoUrls.length
  }

  if (d.lat != null && d.lng != null) {
    auction.lat = d.lat
    auction.lng = d.lng
  }

  // Attachment PDFs (hirdetmény, tulajdoni lap) are deliberately NOT collected:
  // their /attachment/<n>/<hash>/ URLs are bound to the JSESSIONID that
  // rendered the page (verified live: 403 with any other/no session), so a
  // stored URL would be dead for both the UI and the PDF text extraction.
}
