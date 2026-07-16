import type { Auction } from '~/types/auction'
import { SI_API_BASE, SI_BASE, LIST_PATH, COUNTRY, UA, REAL_ESTATE_SALE_SUBJECT, PAGE_SIZE } from './constants'
import { clean, parseSiDateTime, parseSiPrice, formatSiPrice } from './text'

interface SiAddress {
  street: string | null
  houseNumber: string | null
  zip: string | null
  city: string | null
}

interface SiPublication {
  id: string
  caseNumber: number | null
  caseYear: number | null
  registerTypeRelation: { valueContent: string } | null
  courtRelation: { valueContent: string } | null
  saleStartAt: string | null
  saleEndAt: string | null
  status: string
  description: string | null
  propertyKindRelation: { valueContent: string } | null
  area: string | null
  cadastralMunicipalityName: string | null
  startingPrice: string | number | null
  estimatedPrice: string | number | null
  address: SiAddress | null
  pictureFileId: string | null
  pictureFileIdRelation: { urlQuery: string } | null
}

interface SiListResponse {
  list: SiPublication[]
  pagination: { offset: number; limit: number; countAll: number }
}

const MAX_PAGES = 30

function buildAdresse(p: SiPublication): string | null {
  const a = p.address
  if (a && (a.street || a.city || a.zip)) {
    const line = [a.street, a.houseNumber].filter(Boolean).join(' ')
    const cityLine = [a.zip, a.city].filter(Boolean).join(' ')
    return clean(`${line}, ${cityLine}, Slowenien`)
  }
  if (p.cadastralMunicipalityName) return `${p.cadastralMunicipalityName}, Slowenien`
  return null
}

function buildAktenzeichen(p: SiPublication): string {
  const kind = p.registerTypeRelation?.valueContent
  if (!p.caseNumber || !p.caseYear) return ''
  return clean(`${kind ?? ''} ${p.caseNumber}/${p.caseYear}`) ?? ''
}

function buildObjekt(p: SiPublication): string | null {
  const kind = p.propertyKindRelation?.valueContent
  if (!kind) return null
  return p.area ? `${kind}, ${p.area} m²` : kind
}

function mapPublication(p: SiPublication, platformId: string): Auction {
  const { iso: terminIso, label: terminText } = parseSiDateTime(p.saleEndAt)
  const price = parseSiPrice(p.estimatedPrice ?? p.startingPrice)
  const detailUrl = `${SI_BASE}/single/${p.id}`
  const thumbnailUrl =
    p.pictureFileId && p.pictureFileIdRelation
      ? `${SI_API_BASE}/public/download${p.pictureFileIdRelation.urlQuery}`
      : null

  return {
    platform: platformId,
    country: COUNTRY,
    region: '',
    zvgId: p.id,
    aktenzeichen: buildAktenzeichen(p),
    amtsgericht: p.courtRelation?.valueContent ?? '',
    objekt: buildObjekt(p),
    adresse: buildAdresse(p),
    verkehrswertEur: price,
    verkehrswertText: formatSiPrice(price),
    terminIso,
    terminText,
    aufgehoben: p.status === 'canceled',
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: null,
    detailUrlUpstream: detailUrl,
    attachments: [],
    beschreibung: clean(p.description),
    fotoCount: thumbnailUrl ? 1 : 0,
    thumbnailUrl,
  }
}

export async function fetchAllListings(platformId: string): Promise<{ auctions: Auction[]; total: number | null }> {
  const auctions: Auction[] = []
  let offset = 0
  let countAll: number | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${SI_API_BASE}${LIST_PATH}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        filter: { saleSubject: [REAL_ESTATE_SALE_SUBJECT] },
        pagination: { offset, limit: PAGE_SIZE },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`sodnedrazbe.si list fetch failed: ${res.status}`)

    const data = (await res.json()) as SiListResponse
    for (const p of data.list) auctions.push(mapPublication(p, platformId))
    countAll = data.pagination.countAll

    offset += PAGE_SIZE
    if (offset >= countAll) break
  }

  return { auctions, total: countAll }
}
