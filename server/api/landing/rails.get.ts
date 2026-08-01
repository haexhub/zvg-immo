import type { Pool } from 'pg'
import { getPool } from '~/server/utils/db'
import { buildAuctionSearchFilter } from '~/server/utils/auction-search-filters'
import { ensureEnabledCountriesLoaded, listCountries } from '~/server/crawlers/registry'
import { SUMMARY_COLUMNS_SQL, SUMMARY_FROM_SQL, summary, type AuctionSummary, type SearchRow } from '~/server/api/auctions.get'

// Landing-page category rails, Airbnb-style: each rail is a horizontally
// scrolling row of actual auction cards, not a category picker. Country
// rails query auctions.country directly. Geo rails (sea/mountains/lakes/
// rivers) query the osm_local_elements PostGIS dataset (PR #282) via
// ST_DWithin against auctions.lat/lng — no LLM call, no location-context
// backfill lag. They depend on the ansible-side osm2pgsql import actually
// having loaded natural=coastline/water/peak and waterway=river for a
// country (ansible PR #80) — until that import has run, a geo rail simply
// comes back empty for that country rather than erroring.
const RAIL_LIMIT = 12
const COUNTRY_RAIL_CODES = ['se', 'de', 'bg']

interface GeoCategory {
  key: 'sea' | 'mountains' | 'lakes' | 'rivers'
  tagKey: string
  tagValue: string
  radiusMeters: number
}

const GEO_CATEGORIES: GeoCategory[] = [
  { key: 'sea', tagKey: 'natural', tagValue: 'coastline', radiusMeters: 5_000 },
  { key: 'mountains', tagKey: 'natural', tagValue: 'peak', radiusMeters: 15_000 },
  { key: 'lakes', tagKey: 'natural', tagValue: 'water', radiusMeters: 5_000 },
  { key: 'rivers', tagKey: 'waterway', tagValue: 'river', radiusMeters: 2_000 },
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
    ORDER BY a.photo_count DESC, a.updated_at DESC
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
  const geoCondition = `a.lat IS NOT NULL AND a.lng IS NOT NULL AND EXISTS (
    SELECT 1 FROM osm_local_elements o
    WHERE o.country = a.country
      AND o.tags ->> ${add(category.tagKey)} = ${add(category.tagValue)}
      AND ST_DWithin(o.geom::geography, ST_MakePoint(a.lng, a.lat)::geography, ${add(category.radiusMeters)})
  )`
  const predicate = basePredicate ? `${basePredicate} AND ${geoCondition}` : `WHERE ${geoCondition}`
  const sql = `SELECT ${SUMMARY_COLUMNS_SQL}
    ${SUMMARY_FROM_SQL} ${predicate}
    ORDER BY a.photo_count DESC, a.updated_at DESC
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
    ORDER BY (CASE a.condition #>> '{}' WHEN 'neuwertig' THEN 0 WHEN 'gepflegt' THEN 1 ELSE 2 END), a.photo_count DESC, a.updated_at DESC
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
