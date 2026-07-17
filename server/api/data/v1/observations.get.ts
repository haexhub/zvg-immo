// GET /api/data/v1/observations — time-series history from
// auction_observations (server/utils/history.ts), guarded by
// server/middleware/data-api-auth.ts. This is the actual analyst-facing
// value-add of the Daten-API (quota/property-type/price trends over time),
// not just the current snapshot. Filterable by country/region/date range,
// paginated. Response uses the stable PublicObservation contract
// (server/utils/data-api-shape.ts).

import { getPool } from '../../../utils/db'
import { toPublicObservation, type PublicObservation } from '../../../utils/data-api-shape'
import type { PaginatedResponse } from './auctions.get'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 500

export default defineEventHandler(async (event): Promise<PaginatedResponse<PublicObservation>> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Historie ist nicht konfiguriert.' })
  }

  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : undefined
  const region = typeof query.region === 'string' ? query.region : undefined
  const from = typeof query.from === 'string' ? query.from : undefined
  const to = typeof query.to === 'string' ? query.to : undefined
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1)
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query.pageSize)) || DEFAULT_PAGE_SIZE),
  )

  const conditions: string[] = []
  const params: unknown[] = []
  if (country) {
    params.push(country)
    conditions.push(`country = $${params.length}`)
  }
  if (region) {
    params.push(region)
    conditions.push(`region = $${params.length}`)
  }
  if (from) {
    params.push(from)
    conditions.push(`captured_at >= $${params.length}`)
  }
  if (to) {
    params.push(to)
    conditions.push(`captured_at <= $${params.length}`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  params.push(pageSize)
  const limitIdx = params.length
  params.push((page - 1) * pageSize)
  const offsetIdx = params.length

  const { rows } = await db.query(
    `SELECT *, count(*) OVER() AS full_count
     FROM auction_observations
     ${where}
     ORDER BY captured_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )
  const total = rows.length > 0 ? Number(rows[0].full_count) : 0

  return {
    data: rows.map(toPublicObservation),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
})
