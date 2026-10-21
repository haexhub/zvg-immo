// GET /api/data/v1/observations — time-series history from
// auction_observations (server/utils/history.ts), guarded by
// server/middleware/data-api-auth.ts. This is the actual analyst-facing
// value-add of the Daten-API (quota/property-type/price trends over time),
// not just the current snapshot. Filterable by country/region/date range,
// paginated. Response uses the stable PublicObservation contract
// (server/utils/data-api-shape.ts).
//
// Since 2026-10 a row exists per change plus one daily detail row per offered
// auction, not per crawl run: an auction's state at a time is its latest row
// before it.

import { sql } from 'drizzle-orm'
import { getDb } from '../../../utils/db'
import { toPublicObservation, type PublicObservation } from '../../../utils/data-api-shape'
import { parsePagination } from '../../../utils/data-api-pagination'
import type { PaginatedResponse } from './auctions.get'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 500
// Only ISO 8601 dates (optionally with time): V8's legacy Date.parse also
// accepts inputs such as "1" or "March 7" that would mean something else, or
// nothing, to Postgres.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

// Parse once and bind the normalized ISO instant, so Postgres never re-parses
// the raw query string with its own rules (and session time zone).
function parseDateParam(raw: unknown, name: 'from' | 'to'): string | undefined {
  if (typeof raw !== 'string') return undefined
  const date = new Date(raw)
  const day = raw.slice(0, 10)
  // V8 rolls impossible days over (2026-02-30 -> 2026-03-02); reject them.
  const isRealDay = () => new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  if (!ISO_DATE.test(raw) || Number.isNaN(date.getTime()) || !isRealDay()) {
    throw createError({ statusCode: 400, statusMessage: `Ungültiges "${name}"-Datum.` })
  }
  return date.toISOString()
}

export default defineEventHandler(async (event): Promise<PaginatedResponse<PublicObservation>> => {
  const db = getDb()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Historie ist nicht konfiguriert.' })
  }

  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : undefined
  const region = typeof query.region === 'string' ? query.region : undefined
  const from = parseDateParam(query.from, 'from')
  const to = parseDateParam(query.to, 'to')
  const { page, pageSize } = parsePagination(query, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

  const conditions = []
  if (country) conditions.push(sql`country = ${country}`)
  if (region) conditions.push(sql`region = ${region}`)
  if (from) conditions.push(sql`captured_at >= ${from}`)
  if (to) conditions.push(sql`captured_at <= ${to}`)
  const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.execute<{ total: string }>(sql`SELECT count(*) AS total FROM auction_observations ${where}`),
    db.execute(sql`
      SELECT platform, country, region, external_id, authority, case_number,
        title, property_type, land_area_sqm, living_area_sqm, rooms, units,
        market_value_eur, market_value, currency, auction_date_iso, cancelled,
        captured_at
      FROM auction_observations
      ${where}
      ORDER BY captured_at DESC, platform, external_id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
  ])
  const total = Number(countRows[0]!.total)

  return {
    data: rows.map(toPublicObservation),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
})
