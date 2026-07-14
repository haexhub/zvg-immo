import type { Auction } from '~/types/auction'
import {
  GRAPHQL_URL,
  AUCTIONS_QUERY,
  UA,
  COUNTRY,
  REAL_ESTATE_LOT_TYPE,
  COMPLETED_STAGE_MARKER,
} from './constants'

interface SyslumennAuction {
  office: string | null
  location: string | null
  auctionType: string | null
  lotType: string | null
  lotName: string | null
  lotId: string | null
  lotItems: string | null
  auctionDate: string | null
  auctionTime: string | null
  petitioners: string | null
  respondent: string | null
  publishText: string | null
  auctionTakesPlaceAt: string | null
}

interface GraphQlResponse {
  data?: { getSyslumennAuctions?: SyslumennAuction[] | null } | null
}

async function fetchAuctions(): Promise<SyslumennAuction[]> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query: AUCTIONS_QUERY }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`island.is graphql: HTTP ${res.status}`)
  const json = (await res.json()) as GraphQlResponse
  const list = json.data?.getSyslumennAuctions
  if (!Array.isArray(list)) {
    throw new Error('island.is graphql returned no getSyslumennAuctions array')
  }
  return list
}

/** The feed serialises the date US-style ("1/13/2026, 12:00:00 AM"); the real
 *  time of day lives in the separate `auctionTime` field ("13:20", 24h). The
 *  serialised time component is always a placeholder midnight and is ignored.
 *  -> "2026-01-13T13:20:00" (naive local time, matching the other crawlers). */
function parseAuctionDateTime(
  date: string | null,
  time: string | null,
): { iso: string | null; label: string | null } {
  if (!date) return { iso: null, label: null }
  const m = date.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return { iso: null, label: null }
  const [, mo, d, y] = m
  const month = mo!.padStart(2, '0')
  const day = d!.padStart(2, '0')
  const tm = time?.match(/(\d{1,2}):(\d{2})/)
  const hh = tm ? tm[1]!.padStart(2, '0') : '00'
  const mm = tm ? tm[2]! : '00'
  return {
    iso: `${y}-${month}-${day}T${hh}:${mm}:00`,
    label: `${day}.${month}.${y}${tm ? `, ${hh}:${mm} Uhr` : ''}`,
  }
}

function clean(text: string | null | undefined): string | null {
  const t = text?.replace(/\s+/g, ' ').trim()
  return t && t.length > 0 ? t : null
}

function mapItem(item: SyslumennAuction, platformId: string, index: number): Auction {
  const { iso: terminIso, label: terminText } = parseAuctionDateTime(
    item.auctionDate,
    item.auctionTime,
  )

  const beschreibung = [
    clean(item.petitioners) ? `Gläubiger: ${clean(item.petitioners)}` : null,
    clean(item.respondent) ? `Schuldner: ${clean(item.respondent)}` : null,
    clean(item.auctionTakesPlaceAt) ? `Ort: ${clean(item.auctionTakesPlaceAt)}` : null,
    clean(item.publishText),
  ]
    .filter(Boolean)
    .join('\n') || null

  return {
    platform: platformId,
    country: COUNTRY,
    region: 'all',
    zvgId: clean(item.lotId) ?? `is-${index}`,
    // Iceland's forced-sale feed exposes no court case number ("mál nr.") —
    // lotId is the commissioner's internal case id, so it doubles as zvgId
    // above; there is no separate Aktenzeichen.
    aktenzeichen: '',
    amtsgericht: clean(item.office) ?? 'Sýslumenn',
    objekt: clean(item.auctionType),
    adresse: clean(item.lotName),
    // No valuation is published for Icelandic forced sales (bids are taken at
    // the auction), so there is no Verkehrswert.
    verkehrswertEur: null,
    verkehrswertText: null,
    terminIso,
    terminText,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    beschreibung,
    fotoCount: 0,
    thumbnailUrl: null,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const all = await fetchAuctions()
  const relevant = all.filter(
    (a) =>
      a.lotType === REAL_ESTATE_LOT_TYPE &&
      !(a.auctionType ?? '').toLowerCase().includes(COMPLETED_STAGE_MARKER),
  )
  const auctions = relevant.map((item, i) => mapItem(item, platformId, i))
  return { auctions, total: auctions.length }
}
