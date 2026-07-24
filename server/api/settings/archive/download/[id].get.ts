// Downloads one archived blob by its raw_captures.id (not the bare hash, so
// content_type/kind come along in the same query — see
// docs/plans/2026-07-18-raw-archive-g1-design.md's Roh-Archiv Browse-Feature
// section). Runs under settings-auth like every /api/settings/* route — no
// signed URL needed, sidestepping the Kong-401 issue from PR #66.

import { downloadBlob } from '../../../../utils/storage-download'
import { getPool } from '../../../../utils/db'
import { EXT, type BlobContentType } from '../../../../utils/raw-archive'

export default defineEventHandler(async (event) => {
  const id = Number(event.context.params?.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }

  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Archiv ist nicht konfiguriert.' })
  }

  const { rows } = await db.query<{ content_hash: string; content_type: string }>(
    `SELECT rc.content_hash, rb.content_type
     FROM raw_captures rc
     JOIN raw_blobs rb ON rb.content_hash = rc.content_hash
     WHERE rc.id = $1`,
    [id],
  )
  const row = rows[0]
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }

  const buf = await downloadBlob(row.content_hash)
  if (!buf) {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }

  const contentType = row.content_type.replace(/\+gzip$/, '')
  const ext = EXT[contentType as BlobContentType] ?? ''
  setHeader(event, 'content-type', contentType)
  setHeader(event, 'content-disposition', `attachment; filename="${row.content_hash}${ext}"`)
  return buf
})
