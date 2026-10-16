// Level 4 of the Roh-Archiv browser: versioned document-set items plus
// non-document captures for one auction identity `(platform, external_id)`.
// Query lives in server/utils/archive-documents.ts, shared with the
// per-auction technical overview endpoint.

import { getPool } from '../../../utils/db'
import { readArchiveDocuments, type ArchiveDocumentRow } from '../../../utils/archive-documents'

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

  return await readArchiveDocuments(db, platform, externalId)
})
