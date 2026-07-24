// Level 2 of the Roh-Archiv browser: regions within a country. `auctions`
// carries `region` (raw_captures does not), joined on the natural key
// `(platform, external_id)` — no FK, see
// docs/plans/2026-07-18-raw-archive-g1-design.md. LEFT JOIN because a capture
// can exist before/without a matching `auctions` row; those fall into the
// `'—'` bucket rather than being silently dropped.

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
    `SELECT COALESCE(a.region, $2) AS region, count(*) AS count, max(rc.captured_at) AS last_captured_at
     FROM raw_captures rc
     LEFT JOIN auctions a ON a.platform = rc.platform AND a.external_id = rc.external_id
     WHERE rc.country = $1
     GROUP BY COALESCE(a.region, $2)
     ORDER BY region`,
    [country, UNKNOWN_REGION],
  )
  return rows.map((row) => ({
    region: row.region,
    count: Number(row.count),
    lastCapturedAt: row.last_captured_at,
  }))
})
