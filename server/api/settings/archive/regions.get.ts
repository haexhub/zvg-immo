// Level 2 of the Roh-Archiv browser: regions within a country, joined from the
// `auctions` identity row. An earlier attempt at this join was reverted because
// `auctions` was then a volatile mirror rewritten from scratch on every enrich
// run, so one failed upsert chunk could drop a whole Bundesland into the `'—'`
// bucket. Since WP-1 the row is created at first crawl and never deleted, which
// is what makes the join dependable — rows whose region was never captured
// (backfilled as '') still fall into `'—'`.

import { getPool } from '../../../utils/db'

export interface ArchiveRegionRow {
  region: string
  count: number
  lastCapturedAt: string
}

const UNKNOWN_REGION = '—'

export default defineEventHandler(async (event): Promise<ArchiveRegionRow[]> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }
  const country = String(getQuery(event).country ?? '').toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }

  const { rows } = await db.query<{ region: string; count: string; last_captured_at: string }>(
    `SELECT COALESCE(NULLIF(a.region, ''), $2) AS region,
            count(DISTINCT (rc.platform, rc.external_id)) AS count,
            max(rc.captured_at) AS last_captured_at
     FROM artifact_captures rc
     JOIN auctions a ON a.platform = rc.platform AND a.external_id = rc.external_id
     WHERE a.country = $1 AND rc.kind = 'auction'
     GROUP BY COALESCE(NULLIF(a.region, ''), $2)
     ORDER BY region`,
    [country, UNKNOWN_REGION],
  )
  return rows.map((row) => ({
    region: row.region,
    count: Number(row.count),
    lastCapturedAt: row.last_captured_at,
  }))
})
