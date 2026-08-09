// Narrow, bounded read path for the public Daten-API. Internal callers that
// need descriptions, attachments, insights, or photos keep using
// auction-record.ts; this module deliberately selects only the v1 contract.

import { parseAuctionSearchFilters } from '~/lib/auction-search-filter-contract'
import { type PublicAuction } from './data-api-shape'
import { getPool } from './db'

export interface PublicAuctionQuery {
  country?: string
  region?: string
  platform?: string
  propertyType?: string
  includeWithdrawn: boolean
  page: number
  pageSize: number
}

interface PublicAuctionRow {
  platform: string
  external_id: string
  country: string
  region: string
  authority: string
  case_number: string
  title: string | null
  address: string | null
  market_value_eur: string | number | null
  market_value: string | number | null
  currency: string | null
  auction_date_iso: Date | string | null
  cancelled: boolean
  property_type: string | null
  land_area_sqm: string | number | null
  living_area_sqm: string | number | null
  rooms: string | number | null
  units: number | null
  photo_count: number | null
  source_updated_iso: Date | string | null
}

function numberOrNull(value: string | number | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

function toPublicAuction(row: PublicAuctionRow): PublicAuction {
  return {
    platform: row.platform,
    country: row.country,
    region: row.region,
    id: row.external_id,
    court: row.authority,
    caseNumber: row.case_number,
    title: row.title,
    address: row.address,
    marketValueEur: numberOrNull(row.market_value_eur),
    marketValue: numberOrNull(row.market_value),
    currency: row.currency,
    auctionDate: isoOrNull(row.auction_date_iso),
    withdrawn: row.cancelled,
    propertyType: row.property_type,
    landAreaSqm: numberOrNull(row.land_area_sqm),
    livingAreaSqm: numberOrNull(row.living_area_sqm),
    rooms: numberOrNull(row.rooms),
    units: row.units,
    photoCount: row.photo_count ?? 0,
    lastUpdated: isoOrNull(row.source_updated_iso),
    appUrl: `/objekt/${encodeURIComponent(row.platform)}/${encodeURIComponent(row.external_id)}`,
  }
}

function buildWhere(query: PublicAuctionQuery): { where: string; values: unknown[] } {
  const values: unknown[] = []
  const add = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }
  const conditions = [
    // Align the Daten-API's documented current-auction collection with public
    // discovery. Detail lookups stay historical/permalink-safe by design.
    '(a.auction_date_iso IS NULL OR a.auction_date_iso >= now())',
  ]
  // Use the shared URL parser for country spelling/normalization. The v1
  // endpoint intentionally keeps its existing single-country semantics.
  const country = parseAuctionSearchFilters({ country: query.country }).countries[0]
  if (country) conditions.push(`a.country = ${add(country.toLowerCase())}`)
  if (query.region) conditions.push(`a.region = ${add(query.region)}`)
  if (query.platform) conditions.push(`a.platform = ${add(query.platform)}`)
  if (query.propertyType) conditions.push(`d.property_type = ${add(query.propertyType)}`)
  if (!query.includeWithdrawn) conditions.push('a.cancelled = false')
  return { where: `WHERE ${conditions.join(' AND ')}`, values }
}

const PUBLIC_AUCTION_SELECT = `SELECT
  a.platform, a.external_id, a.country, a.region, a.authority, a.case_number,
  a.title, a.auction_date_iso, a.cancelled,
  d.address, d.market_value_eur, d.market_value, d.currency, d.property_type,
  d.land_area_sqm, d.living_area_sqm, d.rooms, d.units, d.photo_count,
  fs.source_updated_iso
FROM auctions a
LEFT JOIN LATERAL (
  SELECT address, market_value_eur, market_value, currency, property_type,
    land_area_sqm, living_area_sqm, rooms, units, photo_count
  FROM auction_details
  WHERE platform = a.platform AND external_id = a.external_id AND is_latest = true
  LIMIT 1
) d ON true
LEFT JOIN auction_fetch_state fs ON fs.platform = a.platform AND fs.external_id = a.external_id`

export async function readPublicAuctions(query: PublicAuctionQuery): Promise<{ data: PublicAuction[]; total: number }> {
  const db = getPool()
  if (!db) return { data: [], total: 0 }
  const { where, values } = buildWhere(query)
  const offset = (query.page - 1) * query.pageSize
  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query<{ total: string }>(`SELECT COUNT(*) AS total FROM auctions a
      LEFT JOIN LATERAL (
        SELECT property_type FROM auction_details
        WHERE platform = a.platform AND external_id = a.external_id AND is_latest = true
        LIMIT 1
      ) d ON true
      ${where}`, values),
    db.query<PublicAuctionRow>(`${PUBLIC_AUCTION_SELECT}
      ${where}
      ORDER BY a.platform, a.external_id
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, query.pageSize, offset]),
  ])
  return { data: rows.map(toPublicAuction), total: Number(countRows[0]?.total ?? 0) }
}
