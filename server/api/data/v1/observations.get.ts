// GET /api/data/v1/observations — time-series history from
// auction_observations (server/utils/history.ts), guarded by
// server/middleware/data-api-auth.ts. This is the actual analyst-facing
// value-add of the Daten-API (quota/property-type/price trends over time),
// not just the current snapshot. Filterable by country/region/date range,
// paginated. Response uses the stable PublicObservation contract
// (server/utils/data-api-shape.ts).

import { sql } from 'drizzle-orm'
import { getDb } from '../../../utils/db'
import { toPublicObservation, type PublicObservation } from '../../../utils/data-api-shape'
import { parsePagination } from '../../../utils/data-api-pagination'
import type { PaginatedResponse } from './auctions.get'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 500

export default defineEventHandler(async (event): Promise<PaginatedResponse<PublicObservation>> => {
  const db = getDb()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Historie ist nicht konfiguriert.' })
  }

  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : undefined
  const region = typeof query.region === 'string' ? query.region : undefined
  const from = typeof query.from === 'string' ? query.from : undefined
  const to = typeof query.to === 'string' ? query.to : undefined
  if (from !== undefined && Number.isNaN(Date.parse(from))) {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiges "from"-Datum.' })
  }
  if (to !== undefined && Number.isNaN(Date.parse(to))) {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiges "to"-Datum.' })
  }
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
      SELECT *
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
