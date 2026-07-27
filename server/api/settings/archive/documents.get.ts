// Level 4 of the Roh-Archiv browser: versioned document-set items plus
// non-document captures for one auction identity `(platform, external_id)`.
// Document rows include setVersion/setHash so the UI can show which files were
// valid together. `id` remains raw_captures.id, so the existing download route
// can resolve content_hash + content_type in one query.

import { getPool } from '../../../utils/db'

export interface ArchiveDocumentRow {
  id: number
  capturedAt: string
  kind: string
  sourceUrl: string | null
  contentType: string
  byteSize: number
  setVersion: number | null
  setHash: string | null
  itemOrdinal: number | null
  label: string | null
  filename: string | null
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
    set_version: number | null
    set_hash: string | null
    item_ordinal: number | null
    label: string | null
    filename: string | null
  }>(
    `WITH set_rows AS (
       SELECT rc.id, rds.captured_at, rdsi.kind, rdsi.source_url, rb.content_type, rb.byte_size,
              rds.version AS set_version, rds.set_hash, rdsi.ordinal AS item_ordinal,
              rdsi.label, rdsi.filename
       FROM raw_document_sets rds
       JOIN raw_document_set_items rdsi ON rdsi.set_id = rds.id
       JOIN raw_captures rc
         ON rc.kind = rdsi.kind
        AND rc.platform = rds.platform
        AND rc.external_id = rds.external_id
        AND COALESCE(rc.source_url, '') = rdsi.source_url
        AND rc.content_hash = rdsi.content_hash
       JOIN raw_blobs rb ON rb.content_hash = rdsi.content_hash
       WHERE rds.platform = $1 AND rds.external_id = $2
     ),
     capture_rows AS (
       SELECT rc.id, rc.captured_at, rc.kind, rc.source_url, rb.content_type, rb.byte_size,
              null::integer AS set_version, null::text AS set_hash, null::integer AS item_ordinal,
              null::text AS label, null::text AS filename
       FROM raw_captures rc
       JOIN raw_blobs rb ON rb.content_hash = rc.content_hash
       WHERE rc.platform = $1 AND rc.external_id = $2 AND rc.kind <> 'document'
     )
     SELECT * FROM set_rows
     UNION ALL
     SELECT * FROM capture_rows
     ORDER BY set_version DESC NULLS LAST, item_ordinal NULLS LAST, captured_at DESC`,
    [platform, externalId],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    capturedAt: row.captured_at,
    kind: row.kind,
    sourceUrl: row.source_url,
    contentType: row.content_type.replace(/\+gzip$/, ''),
    byteSize: Number(row.byte_size),
    setVersion: row.set_version,
    setHash: row.set_hash,
    itemOrdinal: row.item_ordinal,
    label: row.label,
    filename: row.filename,
  }))
})
