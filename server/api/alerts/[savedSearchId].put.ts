// Toggles (or creates, on first enable) the alert subscription for one of
// the caller's own saved searches. server/middleware/supabase-auth.ts has
// already verified event.context.user and 401'd otherwise.

import { getServiceClient } from '../../utils/supabase'
import { parseAuctionSearchFilters, unsupportedAlertFilterKeys } from '~/lib/auction-search-filter-contract'

export default defineEventHandler(async (event): Promise<{ enabled: boolean }> => {
  const savedSearchId = String(event.context.params?.savedSearchId ?? '')
  if (!savedSearchId) {
    throw createError({ statusCode: 400, statusMessage: 'savedSearchId fehlt.' })
  }
  const body = await readBody<{ enabled?: unknown }>(event).catch(() => undefined) ?? ({} as { enabled?: unknown })
  const enabled = body.enabled !== false

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const userId = event.context.user!.id

  // Ownership check: the FK alone doesn't scope by user, and savedSearchId
  // is otherwise trusted input from the request path.
  const { data: search, error: searchError } = await supabase
    .from('saved_searches')
    .select('id, filters')
    .eq('id', savedSearchId)
    .eq('user_id', userId)
    .maybeSingle()
  if (searchError) {
    throw createError({ statusCode: 500, statusMessage: searchError.message })
  }
  if (!search) {
    throw createError({ statusCode: 404, statusMessage: 'Gespeicherte Suche nicht gefunden.' })
  }
  if (enabled) {
    const unsupported = unsupportedAlertFilterKeys(parseAuctionSearchFilters(search.filters as Record<string, unknown>))
    if (unsupported.length) {
      throw createError({
        statusCode: 400,
        statusMessage: `Diese gespeicherte Suche enthält nicht alertfähige Filter: ${unsupported.join(', ')}.`,
      })
    }
  }

  const { error } = await supabase
    .from('alert_subscriptions')
    .upsert({ user_id: userId, saved_search_id: savedSearchId, enabled }, { onConflict: 'saved_search_id' })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return { enabled }
})
