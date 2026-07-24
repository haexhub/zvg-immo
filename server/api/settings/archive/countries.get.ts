// Level 1 of the Roh-Archiv browser (Land → Region → Aktenzeichen →
// Dokumente, see docs/plans/2026-07-18-raw-archive-g1-design.md): one row per
// country that has at least one raw_captures entry. Lives under
// /api/settings/ and therefore automatically inherits
// server/middleware/settings-auth.ts's guard.

import { getPool } from '../../../utils/db'
import { countryDisplayName } from '../../../utils/countries'

export interface ArchiveCountryRow {
  code: string
  label: string
  count: number
  lastCapturedAt: string
}

export default defineEventHandler(async (): Promise<ArchiveCountryRow[]> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }

  const { rows } = await db.query<{ country: string; count: string; last_captured_at: string }>(
    `SELECT country, count(*) AS count, max(captured_at) AS last_captured_at
     FROM raw_captures
     GROUP BY country
     ORDER BY country`,
  )
  return rows.map((row) => ({
    code: row.country,
    label: countryDisplayName(row.country),
    count: Number(row.count),
    lastCapturedAt: row.last_captured_at,
  }))
})
