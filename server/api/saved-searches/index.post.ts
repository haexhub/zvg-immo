// Saves the current filter set under a user-chosen name. `filters` is stored
// as-is (the query-param object pages/index.vue POSTs, i.e. route.query) —
// jsonb, no schema of its own; see lib/auction-filters.ts for the field names.

import { getServiceClient } from '../../utils/supabase'
import type { SavedSearch } from './index.get'

export default defineEventHandler(async (event): Promise<SavedSearch> => {
  const body = await readBody<{ name?: unknown; filters?: unknown }>(event).catch(
    () => undefined,
  ) ?? ({} as { name?: unknown; filters?: unknown })
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Name fehlt.' })
  }
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {}

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('saved_searches')
    .insert({ user_id: event.context.user!.id, name, filters })
    .select('id, name, filters, created_at')
    .single()
  if (error || !data) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Speichern fehlgeschlagen.' })
  }
  return {
    id: data.id as string,
    name: data.name as string,
    filters: data.filters as Record<string, string>,
    createdAt: data.created_at as string,
  }
})
