import type { Pool } from 'pg'
import { getPool } from '~/server/utils/db'
import { buildAuctionSearchFilter } from '~/server/utils/auction-search-filters'
import { ensureEnabledCountriesLoaded, listCountries } from '~/server/crawlers/registry'
import { SUMMARY_COLUMNS_SQL, SUMMARY_FROM_SQL, summary, type AuctionSummary, type SearchRow } from '~/server/api/auctions.get'

// Landing-page category rails, Airbnb-style: each rail is a horizontally
// scrolling row of actual auction cards, not a category picker. Country
// rails query auctions.country directly. Geo rails (sea/mountains/lakes/
// rivers) compare against auction_geo_metrics (GIS WP-5) — no LLM call, no
// location-context backfill lag, and (since WP-5) no live geometry query
// either. They depend on that table having a row for the auction, which in
// turn depends on the nightly precompute job (build-auction-geo-metrics.ts)
// having run against a completed geo_features epoch (WP-4), which in turn
// depends on the ansible-side osm2pgsql import having loaded the relevant
// tags for that country (WP-6) — until all of that has run, a geo rail
// simply comes back empty for that country rather than erroring, same
// contract as before WP-5.
const RAIL_LIMIT = 12
const COUNTRY_RAIL_CODES = ['se', 'de', 'bg']

interface GeoCategory {
  key: 'sea' | 'mountains' | 'lakes' | 'rivers'
  /** auction_geo_metrics column. */
  column: string
  radiusMeters: number
}

const GEO_CATEGORIES: GeoCategory[] = [
  { key: 'sea', column: 'dist_sea_m', radiusMeters: 5_000 },
  { key: 'mountains', column: 'dist_mountain_m', radiusMeters: 15_000 },
  { key: 'lakes', column: 'dist_lake_m', radiusMeters: 5_000 },
  { key: 'rivers', column: 'dist_river_m', radiusMeters: 2_000 },
]

export interface CountryRail {
  code: string
  name: string
  auctions: AuctionSummary[]
}

export interface LandingRailsResponse {
  countryRails: CountryRail[]
  bestCondition: AuctionSummary[]
  sea: AuctionSummary[]
  mountains: AuctionSummary[]
  lakes: AuctionSummary[]
  rivers: AuctionSummary[]
}

async function countryRail(db: Pool, code: string): Promise<AuctionSummary[]> {
  const { predicate, values } = await buildAuctionSearchFilter(db, { country: code, photos: '1' })
  const sql = `SELECT ${SUMMARY_COLUMNS_SQL}
    ${SUMMARY_FROM_SQL} ${predicate}
    ORDER BY d.photo_count DESC NULLS LAST, a.updated_at DESC
    LIMIT $${values.length + 1}`
  const { rows } = await db.query<SearchRow>(sql, [...values, RAIL_LIMIT])
  return rows.map(summary)
}

async function geoRail(db: Pool, category: GeoCategory): Promise<AuctionSummary[]> {
  const { predicate: basePredicate, values: baseValues } = await buildAuctionSearchFilter(db, { photos: '1' })
  const values = [...baseValues]
  const add = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }
  const geoCondition = `m.${category.column} <= ${add(category.radiusMeters)}`
  const predicate = basePredicate ? `${basePredicate} AND ${geoCondition}` : `WHERE ${geoCondition}`
  const sql = `SELECT ${SUMMARY_COLUMNS_SQL}
    ${SUMMARY_FROM_SQL} ${predicate}
    ORDER BY d.photo_count DESC NULLS LAST, a.updated_at DESC
    LIMIT ${add(RAIL_LIMIT)}`
  const { rows } = await db.query<SearchRow>(sql, values)
  return rows.map(summary)
}

export default defineEventHandler(async (event): Promise<LandingRailsResponse> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Auktionsdatenbank ist nicht konfiguriert' })
  }

  await ensureEnabledCountriesLoaded()
  const countryNames = new Map(listCountries().map((c) => [c.code, c.name]))

  const { predicate: conditionPredicate, values: conditionValues } = await buildAuctionSearchFilter(db, {
    condition: 'neuwertig,gepflegt',
    photos: '1',
  })
  const bestConditionSql = `SELECT ${SUMMARY_COLUMNS_SQL}
    ${SUMMARY_FROM_SQL} ${conditionPredicate}
    ORDER BY (CASE d.condition #>> '{}' WHEN 'neuwertig' THEN 0 WHEN 'gepflegt' THEN 1 ELSE 2 END), d.photo_count DESC NULLS LAST, a.updated_at DESC
    LIMIT $${conditionValues.length + 1}`

  const [countryRailResults, bestConditionResult, sea, mountains, lakes, rivers] = await Promise.all([
    Promise.all(COUNTRY_RAIL_CODES.map((code) => countryRail(db, code))),
    db.query<SearchRow>(bestConditionSql, [...conditionValues, RAIL_LIMIT]),
    geoRail(db, GEO_CATEGORIES[0]!),
    geoRail(db, GEO_CATEGORIES[1]!),
    geoRail(db, GEO_CATEGORIES[2]!),
    geoRail(db, GEO_CATEGORIES[3]!),
  ])

  const countryRails: CountryRail[] = COUNTRY_RAIL_CODES.map((code, i) => ({
    code,
    name: countryNames.get(code) ?? code,
    auctions: countryRailResults[i]!,
  })).filter((rail) => rail.auctions.length > 0)

  setResponseHeader(event, 'cache-control', 'no-store')
  return {
    countryRails,
    bestCondition: bestConditionResult.rows.map(summary),
    sea,
    mountains,
    lakes,
    rivers,
  }
})
