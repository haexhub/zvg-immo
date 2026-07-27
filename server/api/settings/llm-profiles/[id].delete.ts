// Deletes a single reusable LLM provider profile immediately (not gated
// behind the profile list's "Speichern" button). Admin-only via
// /api/settings/'s settings-auth guard. Also prunes any use-case assignment
// pointing to the deleted profile.

import { getPool } from '~/server/utils/db'
import { deleteLlmProviderProfile } from '~/server/utils/app-settings'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const id = String(event.context.params?.id ?? '')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'id fehlt.' })
  }
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  await deleteLlmProviderProfile(db, id)
  return { ok: true }
})
