// Level 3 of the Roh-Archiv browser: individual auctions ("Aktenzeichen")
// within a country+region. Grouped by the identity key `(platform,
// external_id)` — not by case_number, which is nullable and not globally
// unique (docs/plans/2026-07-18-raw-archive-g1-design.md) — so the identity
// key is what gets passed through to the next level (documents.get.ts), and
// case_number/authority are display-only aggregates.

import { getPool } from '../../../utils/db'

export interface ArchiveCaseRow {
  platform: string
  externalId: string
  caseLabel: string
  authority: string | null
  count: number
  lastCapturedAt: string
}

const UNKNOWN_REGION = '—'

export default defineEventHandler(async (event): Promise<ArchiveCaseRow[]> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }
  const query = getQuery(event)
  const country = String(query.country ?? '').toLowerCase()
  const region = String(query.region ?? '')
  if (!country || !region) {
    throw createError({ statusCode: 400, statusMessage: 'country/region fehlt.' })
  }

  const { rows } = await db.query<{
    platform: string
    external_id: string
    case_label: string
    authority: string | null
    count: string
    last_captured_at: string
  }>(
    `SELECT platform, external_id,
            COALESCE(max(case_number), external_id) AS case_label,
            max(authority) AS authority,
            count(*) FILTER (WHERE kind = 'auction') AS count,
            max(captured_at) AS last_captured_at
     FROM raw_captures
     WHERE country = $1 AND kind = 'auction' AND COALESCE(NULLIF(region, ''), $3) = $2
     GROUP BY platform, external_id
     ORDER BY case_label`,
    [country, region, UNKNOWN_REGION],
  )
  return rows.map((row) => ({
    platform: row.platform,
    externalId: row.external_id,
    caseLabel: row.case_label,
    authority: row.authority,
    count: Number(row.count),
    lastCapturedAt: row.last_captured_at,
  }))
})
