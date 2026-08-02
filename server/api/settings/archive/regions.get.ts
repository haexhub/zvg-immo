// Level 2 of the Roh-Archiv browser: regions within a country. `region` is
// stored directly on artifact_captures at capture time (see raw-archive.ts) — it
// used to be joined live from `auctions`, but that table is a volatile
// current-state mirror rebuilt from scratch on every enrich run, so a single
// failed crawl/upsert for a Bundesland could make its entire capture history
// vanish into the `'—'` bucket. Older rows captured before region was added
// are backfilled from `auctions` once (schema.sql), then null forever after
// that if nothing new is ever captured for that identity — those still fall
// into `'—'`.

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
    `SELECT COALESCE(NULLIF(region, ''), $2) AS region,
            count(DISTINCT (platform, external_id)) AS count,
            max(captured_at) AS last_captured_at
     FROM artifact_captures
     WHERE country = $1 AND kind = 'auction'
     GROUP BY COALESCE(NULLIF(region, ''), $2)
     ORDER BY region`,
    [country, UNKNOWN_REGION],
  )
  return rows.map((row) => ({
    region: row.region,
    count: Number(row.count),
    lastCapturedAt: row.last_captured_at,
  }))
})
