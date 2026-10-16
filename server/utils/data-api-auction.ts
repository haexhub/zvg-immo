// Narrow, bounded read path for the public Daten-API. Internal callers that
// need descriptions, attachments, insights, or photos keep using
// auction-record.ts; this module deliberately selects only the v1 contract.

import { parseAuctionSearchFilters } from '~/lib/auction-search-filter-contract'
import { ensureEnabledCountriesLoaded, getEnabledCountryCodes } from '~/server/crawlers/registry'
import { type PublicAuction } from './data-api-shape'
import { CURRENT_AUCTION_CONDITIONS } from './current-auction-sql'
import { getPool } from './db'
import { redactAffectedPersonNames } from './public-auction-redaction'

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
    title: redactAffectedPersonNames(row.title) ?? null,
    address: redactAffectedPersonNames(row.address) ?? null,
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
    appUrl: publicAppUrl(row.platform, row.external_id),
  }
}

function publicAppUrl(platform: string, externalId: string): string {
  return `/objekt/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`
}

type PublicAuctionFilter = Omit<PublicAuctionQuery, 'page' | 'pageSize'>

function buildWhere(query: PublicAuctionFilter, enabledCountries: string[]): { where: string; values: unknown[] } {
  const values: unknown[] = []
  const add = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }
  // Same current-auction rule as public discovery (current-auction-sql.ts).
  // Detail lookups stay historical/permalink-safe by design.
  const conditions: string[] = [...CURRENT_AUCTION_CONDITIONS]
  // Use the shared URL parser for country spelling/normalization. The v1
  // endpoint intentionally keeps its existing single-country semantics.
  // A paused country is no longer crawled, so its crawl_state never advances
  // and the staleness rule above cannot expire its listings; scope to the
  // enabled countries like public discovery does (auction-search-filters.ts).
  const country = parseAuctionSearchFilters({ country: query.country }).countries[0]?.toLowerCase()
  const countries = country ? enabledCountries.filter((entry) => entry === country) : enabledCountries
  conditions.push(`a.country = ANY(${add(countries)}::text[])`)
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
  await ensureEnabledCountriesLoaded()
  const { where, values } = buildWhere(query, getEnabledCountryCodes())
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

/**
 * App URLs of current, non-withdrawn auctions for the sitemap: the same
 * collection rule as readPublicAuctions, but one bounded read in the same stable order
 * instead of paging with a repeated COUNT(*) and ever-growing OFFSET scans.
 */
export async function readPublicAuctionLinks(limit: number): Promise<Array<Pick<PublicAuction, 'appUrl' | 'lastUpdated'>>> {
  const db = getPool()
  if (!db) return []
  await ensureEnabledCountriesLoaded()
  const { where, values } = buildWhere({ includeWithdrawn: false }, getEnabledCountryCodes())
  const { rows } = await db.query<Pick<PublicAuctionRow, 'platform' | 'external_id' | 'source_updated_iso'>>(
    `SELECT a.platform, a.external_id, fs.source_updated_iso
      FROM auctions a
      LEFT JOIN auction_fetch_state fs ON fs.platform = a.platform AND fs.external_id = a.external_id
      ${where}
      ORDER BY a.platform, a.external_id
      LIMIT $${values.length + 1}`,
    [...values, limit],
  )
  return rows.map((row) => ({
    appUrl: publicAppUrl(row.platform, row.external_id),
    lastUpdated: isoOrNull(row.source_updated_iso),
  }))
}
