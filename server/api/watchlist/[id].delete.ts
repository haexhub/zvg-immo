// Un-favorites an auction, given the watchlist row's own id (as returned by
// GET/POST /api/watchlist) — scoped to the caller so a foreign id can't
// delete another user's row.

import { getServiceClient } from '../../utils/supabase'
import { publicError } from '../../utils/public-error'
import { isUuidSegment } from '../../utils/path-segment'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const id = String(event.context.params?.id ?? '')
  if (!isUuidSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'id fehlt oder ist ungültig.' })
  }
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { error } = await supabase
    .from('watchlist_items')
    .delete()
    .eq('id', id)
    .eq('user_id', event.context.user!.id)
  if (error) {
    throw publicError('DELETE /api/watchlist', 500, 'Löschen fehlgeschlagen.', error)
  }
  return { ok: true }
})
