import { getPool } from '~/server/utils/db'
import { buildAuctionSearchFilter } from '~/server/utils/auction-search-filters'
import { ensureEnabledCountriesLoaded, listCountries } from '~/server/crawlers/registry'
import { SUMMARY_COLUMNS_SQL, SUMMARY_FROM_SQL, summary, type AuctionSummary, type SearchRow } from '~/server/api/auctions.get'

// Landing-page category rails. Kept to the categories that are servable
// today from existing columns (auctions.country, auctions.condition) —
// "am Meer" / "am See" / "in den Bergen" need the osm_local_elements PostGIS
// dataset from PR #282 plus a coastline/water/peak-tag import that doesn't
// exist yet, so those rails aren't wired here. Adding them later is another
// query following the same shape as bestCondition below, not a redesign.
const RAIL_LIMIT = 12

export interface CountryTileEntry {
  code: string
  name: string
  count: number
  thumbnailUrl: string | null
}

export interface LandingRailsResponse {
  countries: CountryTileEntry[]
  bestCondition: AuctionSummary[]
}

export default defineEventHandler(async (event): Promise<LandingRailsResponse> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Auktionsdatenbank ist nicht konfiguriert' })
  }

  await ensureEnabledCountriesLoaded()
  const countryNames = new Map(listCountries().map((c) => [c.code, c.name]))

  const { predicate: basePredicate, values: baseValues } = await buildAuctionSearchFilter(db, {})
  const countryPredicate = basePredicate ? `${basePredicate} AND a.photo_count > 0` : 'WHERE a.photo_count > 0'
  const countryRowsSql = `SELECT DISTINCT ON (a.country) ${SUMMARY_COLUMNS_SQL}
    ${SUMMARY_FROM_SQL} ${countryPredicate}
    ORDER BY a.country, a.photo_count DESC, a.updated_at DESC`
  const countryCountsSql = `SELECT a.country, count(*)::int AS count
    ${SUMMARY_FROM_SQL} ${basePredicate}
    GROUP BY a.country`

  const { predicate: conditionPredicate, values: conditionValues } = await buildAuctionSearchFilter(db, {
    condition: 'neuwertig,gepflegt',
    photos: '1',
  })
  const bestConditionSql = `SELECT ${SUMMARY_COLUMNS_SQL}
    ${SUMMARY_FROM_SQL} ${conditionPredicate}
    ORDER BY (CASE a.condition #>> '{}' WHEN 'neuwertig' THEN 0 WHEN 'gepflegt' THEN 1 ELSE 2 END), a.photo_count DESC, a.updated_at DESC
    LIMIT $${conditionValues.length + 1}`

  const [countryRowsResult, countryCountsResult, bestConditionResult] = await Promise.all([
    db.query<SearchRow>(countryRowsSql, baseValues),
    db.query<{ country: string; count: number }>(countryCountsSql, baseValues),
    db.query<SearchRow>(bestConditionSql, [...conditionValues, RAIL_LIMIT]),
  ])

  const thumbnailByCountry = new Map(countryRowsResult.rows.map((row) => [row.country, summary(row).thumbnailUrl]))
  const countries: CountryTileEntry[] = countryCountsResult.rows
    .map((row) => ({
      code: row.country,
      name: countryNames.get(row.country) ?? row.country,
      count: row.count,
      thumbnailUrl: thumbnailByCountry.get(row.country) ?? null,
    }))
    .sort((a, b) => b.count - a.count)

  setResponseHeader(event, 'cache-control', 'no-store')
  return {
    countries,
    bestCondition: bestConditionResult.rows.map(summary),
  }
})
