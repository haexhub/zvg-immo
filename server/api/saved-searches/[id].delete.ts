// Deletes one of the caller's own saved searches. Scoped by user_id in
// addition to id so a guessed/foreign id can't delete another user's row
// even though this uses the service client (RLS-bypassing) — same
// defense-in-depth stance as the rest of Phase 2's routes.

import { getServiceClient } from '../../utils/supabase'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const id = String(event.context.params?.id ?? '')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'id fehlt.' })
  }
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { error } = await supabase
    .from('saved_searches')
    .delete()
    .eq('id', id)
    .eq('user_id', event.context.user!.id)
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return { ok: true }
})
