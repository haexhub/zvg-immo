// Revokes one of the caller's own API keys. Sets active=false rather than
// deleting the row: api_usage rows FK-cascade off api_keys.id, and a hard
// delete would silently erase that key's usage history (relevant for the
// later billing phase, see the plan). Either revoke strategy stops the key
// working immediately — server/utils/api-key.ts's lookup filters on
// active=true — this just also keeps the audit trail.

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
    .from('api_keys')
    .update({ active: false })
    .eq('id', id)
    .eq('user_id', event.context.user!.id)
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return { ok: true }
})
