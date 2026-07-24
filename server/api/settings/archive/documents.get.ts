// Level 4 of the Roh-Archiv browser: every capture for one auction identity
// `(platform, external_id)`. Append-only log — no dedup by content_hash, each
// capture stays its own downloadable row (deliberate, see
// docs/plans/2026-07-18-raw-archive-g1-design.md). `id` is what
// download/[id].get.ts takes to resolve content_hash + content_type in one
// query.

import { getPool } from '../../../utils/db'

export interface ArchiveDocumentRow {
  id: number
  capturedAt: string
  kind: string
  sourceUrl: string | null
  contentType: string
  byteSize: number
}

export default defineEventHandler(async (event): Promise<ArchiveDocumentRow[]> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }
  const query = getQuery(event)
  const platform = String(query.platform ?? '')
  const externalId = String(query.externalId ?? '')
  if (!platform || !externalId) {
    throw createError({ statusCode: 400, statusMessage: 'platform/externalId fehlt.' })
  }

  const { rows } = await db.query<{
    id: string
    captured_at: string
    kind: string
    source_url: string | null
    content_type: string
    byte_size: string
  }>(
    `SELECT rc.id, rc.captured_at, rc.kind, rc.source_url, rb.content_type, rb.byte_size
     FROM raw_captures rc
     JOIN raw_blobs rb ON rb.content_hash = rc.content_hash
     WHERE rc.platform = $1 AND rc.external_id = $2
     ORDER BY rc.captured_at DESC`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    capturedAt: row.captured_at,
    kind: row.kind,
    sourceUrl: row.source_url,
    contentType: row.content_type.replace(/\+gzip$/, ''),
    byteSize: Number(row.byte_size),
  }))
})
