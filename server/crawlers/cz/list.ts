import type { Auction } from '~/types/auction'
import { CZ_BASE, COUNTRY, UA } from './constants'
import { parseCzDate, parseCzPrice, clean } from './text'

interface CzItem {
  title?: string | null
  description_plaintext?: string | null
  category?: { type?: string }
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

interface CzAuction {
  hash?: string | null
  number?: string | null
  voluntary?: boolean
  enabled?: boolean
  status?: string | null
  start_at?: string | null
  updated_at?: string | null
  estimated_price?: number | null
  location_district?: CzLocationDistrict | null
  link?: string | null
  item?: CzItem
  auctioneer_office?: CzAuctioneerOffice
  images?: unknown[]
}

export async function fetchEndpoint(path: string, platformId: string): Promise<Auction[]> {
  const url = `${CZ_BASE}${path}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`CZ list fetch failed: ${res.status} ${url}`)
  const data = (await res.json()) as Record<string, CzAuction>
  return parseData(data, platformId)
}

function parseData(data: Record<string, CzAuction>, platformId: string): Auction[] {
  const auctions: Auction[] = []
  for (const raw of Object.values(data)) {
    if (raw.voluntary !== false) continue
    if (raw.item?.category?.type !== 'real') continue
    if (!raw.hash) continue

    const district = extractDistrict(raw)
    const detailUrl = raw.link ?? null

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: district,
      zvgId: raw.hash,
      aktenzeichen: raw.number ?? '',
      amtsgericht: clean(raw.auctioneer_office?.title),
      objekt: clean(raw.item?.title) || null,
      adresse: district ? `${district}, Tschechien` : 'Tschechien',
      verkehrswertEur: parseCzPrice(raw.estimated_price),
      verkehrswertText: raw.estimated_price != null ? `${raw.estimated_price} Kč` : null,
      terminIso: parseCzDate(raw.start_at),
      terminText: raw.start_at ?? null,
      aufgehoben: raw.enabled === false || raw.status === 'cancelled',
      letzteAktualisierungIso: parseCzDate(raw.updated_at),
      pdfUrl: null,
      detailUrl,
      pdfUrlUpstream: null,
      detailUrlUpstream: detailUrl,
      attachments: [],
      beschreibung: clean(raw.item?.description_plaintext) || null,
      fotoCount: Array.isArray(raw.images) ? raw.images.length : 0,
      thumbnailUrl: null,
    })
  }
  return auctions
}

function extractDistrict(raw: CzAuction): string {
  const loc = raw.location_district
  if (loc) {
    return clean(loc.city?.city_name ?? loc.district_name ?? loc.county?.county_name)
  }
  return clean(raw.auctioneer_office?.district)
}
