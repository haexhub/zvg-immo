import type { Attachment, AttachmentKind, Auction } from '~/types/auction'
import { CZ_BASE, COUNTRY, UA } from './constants'
import { parseCzDate, parseCzPrice, clean } from './text'
import { getRates, toEur } from '~/server/utils/exchange-rate'

interface CzCoords {
  latitude?: number | null
  longitude?: number | null
}

interface CzRuian {
  city_name?: string | null
  street_name?: string | null
  house_number?: string | null
  street_number?: string | null
  coords?: CzCoords | null
}

interface CzItem {
  title?: string | null
  description_plaintext?: string | null
  category?: { type?: string }
  location_coords?: CzCoords | null
  ruian?: CzRuian | null
}

interface CzImage {
  pathname?: string | null
  mime_type?: string | null
  original_name?: string | null
  hash?: string | null
  priority?: number | null
}

interface CzDocument {
  mime_type?: string | null
  size?: number | null
  original_name?: string | null
  hash?: string | null
  document_type?: string | null
}

interface CzAuctioneerOffice {
  title?: string | null
  district?: string | null
}

interface CzLocationDistrict {
  district_name?: string | null
  county?: { county_name?: string | null }
  city?: { city_name?: string | null }
}

export interface CzAuction {
  hash?: string | null
  number?: string | null
  voluntary?: boolean
  enabled?: boolean
  status?: string | null
  start_at?: string | null
  updated_at?: string | null
  estimated_price?: number | null
  location_district?: CzLocationDistrict | null
  location_coords?: CzCoords | null
  ruian?: CzRuian | null
  link?: string | null
  item?: CzItem
  auctioneer_office?: CzAuctioneerOffice
  /** Keyed object map when non-empty, `[]` when empty. */
  images?: Record<string, CzImage> | CzImage[] | null
  /** Keyed object map when non-empty, `[]` when empty. */
  documents?: Record<string, CzDocument> | CzDocument[] | null
}

/** The API serialises empty collections as `[]` and non-empty ones as a
 *  hash-keyed object map — normalise both to an array. */
function collectionValues<T>(v: Record<string, T> | T[] | null | undefined): T[] {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') return Object.values(v)
  return []
}

function documentKind(type: string | null | undefined): AttachmentKind {
  if (type === 'auction_decree') return 'bekanntmachung'
  if (type === 'expert_report' || type === 'expert_report_appendix') return 'gutachten'
  return 'sonstiges'
}

export async function fetchEndpoint(path: string, platformId: string): Promise<Auction[]> {
  const url = `${CZ_BASE}${path}`
  const [res, rates] = await Promise.all([
    fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }),
    getRates(),
  ])
  if (!res.ok) throw new Error(`CZ list fetch failed: ${res.status} ${url}`)
  const json = await res.json()
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new Error(`CZ list unexpected response shape: ${url}`)
  return parseData(json as Record<string, CzAuction>, platformId, rates)
}

export function parseData(data: Record<string, CzAuction>, platformId: string, rates: Record<string, number>): Auction[] {
  const auctions: Auction[] = []
  for (const raw of Object.values(data)) {
    // The response carries scalar metadata entries like "@count".
    if (!raw || typeof raw !== 'object') continue
    if (raw.voluntary === true) continue
    if (raw.item?.category?.type !== 'real') continue
    if (!raw.hash) continue

    const district = extractDistrict(raw)
    const detailUrl = raw.link || null
    const czk = parseCzPrice(raw.estimated_price)

    const photoUrls = collectionValues(raw.images)
      .filter((img) => img.hash)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((img) => `${CZ_BASE}/upload/auction-image/${img.hash}`)

    /** /upload/auction-document serves the file without cookies/Referer, so
     *  the upstream URL doubles as proxyUrl (same pattern as dk/ee). */
    const attachments: Attachment[] = collectionValues(raw.documents)
      .filter((doc) => doc.hash)
      .map((doc) => ({
        kind: documentKind(doc.document_type),
        label: clean(doc.original_name) || 'Dokument',
        filename: clean(doc.original_name) || `${doc.hash}.pdf`,
        sizeBytes: doc.size ?? null,
        fileId: doc.hash!,
        proxyUrl: `${CZ_BASE}/upload/auction-document/${doc.hash}`,
      }))
    const pdf = attachments.find((a) => a.kind === 'bekanntmachung') ?? attachments[0] ?? null

    const coords =
      raw.item?.location_coords ??
      raw.item?.ruian?.coords ??
      raw.location_coords ??
      raw.ruian?.coords ??
      null

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: district,
      zvgId: raw.hash,
      aktenzeichen: raw.number ?? '',
      amtsgericht: clean(raw.auctioneer_office?.title),
      objekt: clean(raw.item?.title) || null,
      adresse: extractAdresse(raw, district),
      verkehrswertEur: czk != null ? toEur(czk, 'CZK', rates) : null,
      verkehrswertText: czk != null ? `${czk.toLocaleString('de-DE', { maximumFractionDigits: 0 })} Kč` : null,
      terminIso: parseCzDate(raw.start_at),
      terminText: raw.start_at ?? null,
      aufgehoben: raw.enabled === false || raw.status === 'cancelled',
      letzteAktualisierungIso: parseCzDate(raw.updated_at),
      pdfUrl: pdf?.proxyUrl ?? null,
      detailUrl,
      pdfUrlUpstream: pdf?.proxyUrl ?? null,
      detailUrlUpstream: detailUrl,
      attachments,
      beschreibung: clean(raw.item?.description_plaintext) || null,
      fotoCount: photoUrls.length,
      thumbnailUrl: photoUrls[0] ?? null,
      photoUrls,
      lat: typeof coords?.latitude === 'number' ? coords.latitude : null,
      lng: typeof coords?.longitude === 'number' ? coords.longitude : null,
    })
  }
  return auctions
}

function extractDistrict(raw: CzAuction): string {
  const loc = raw.location_district
  if (loc) {
    const name = clean(loc.city?.city_name ?? loc.district_name ?? loc.county?.county_name)
    if (name) return name
  }
  return clean(raw.auctioneer_office?.district)
}

/** Prefer the RUIAN cadastre address ("Zámecká 230/31, Přerov" — or
 *  "Jestřebí 72" for villages without street names) over the bare district. */
function extractAdresse(raw: CzAuction, district: string): string {
  const ruian = raw.item?.ruian ?? raw.ruian
  if (ruian) {
    const city = clean(ruian.city_name)
    const street = clean(ruian.street_name)
    const number = [clean(ruian.house_number), clean(ruian.street_number)].filter(Boolean).join('/')
    let line = ''
    if (street) line = clean(`${street} ${number}`) + (city ? `, ${city}` : '')
    else if (city) line = clean(`${city} ${number}`)
    if (line) return `${line}, Tschechien`
  }
  return district ? `${district}, Tschechien` : 'Tschechien'
}
