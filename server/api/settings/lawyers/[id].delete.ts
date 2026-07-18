// Deletes a lawyer from the catalog. Admin-only via /api/settings/'s
// settings-auth guard. `lawyer_inquiries.lawyer_id` is `ON DELETE RESTRICT`
// (those rows are billing records, see server/db/schema.sql) — Postgres
// rejects the delete with a foreign_key_violation when any inquiry
// references this lawyer. Surface that as a clear 409 telling the caller to
// deactivate instead, rather than letting a raw Postgres error bubble up as
// an opaque 500.

import { getServiceClient } from '../../../utils/supabase'

const FOREIGN_KEY_VIOLATION = '23503'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const id = String(event.context.params?.id ?? '')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'id fehlt.' })
  }
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { error } = await supabase.from('lawyers').delete().eq('id', id)
  if (error) {
    if (error.code === FOREIGN_KEY_VIOLATION) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Dieser Anwalt hat bereits Anfragen erhalten und kann nicht gelöscht werden. Bitte stattdessen deaktivieren.',
      })
    }
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return { ok: true }
})
