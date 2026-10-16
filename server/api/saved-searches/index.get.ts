// Lists the caller's saved searches (server/middleware/supabase-auth.ts has
// already verified event.context.user and 401'd otherwise).

import { getServiceClient } from '../../utils/supabase'
import { publicError } from '../../utils/public-error'

export interface SavedSearch {
  id: string
  name: string
  filters: Record<string, string>
  createdAt: string
}

export default defineEventHandler(async (event): Promise<SavedSearch[]> => {
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('saved_searches')
    .select('id, name, filters, created_at')
    .eq('user_id', event.context.user!.id)
    .order('created_at', { ascending: false })
  if (error) {
    throw publicError('GET /api/saved-searches', 500, 'Gespeicherte Suchen konnten nicht geladen werden.', error)
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    filters: row.filters as Record<string, string>,
    createdAt: row.created_at as string,
  }))
})
