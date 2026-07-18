// Lists the caller's watchlist items.

import { getServiceClient } from '../../utils/supabase'

export interface WatchlistItem {
  id: string
  platform: string
  externalId: string
  authority: string | null
  caseNumber: string | null
  createdAt: string
}

export default defineEventHandler(async (event): Promise<WatchlistItem[]> => {
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('id, platform, external_id, authority, case_number, created_at')
    .eq('user_id', event.context.user!.id)
    .order('created_at', { ascending: false })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    platform: row.platform as string,
    externalId: row.external_id as string,
    authority: row.authority as string | null,
    caseNumber: row.case_number as string | null,
    createdAt: row.created_at as string,
  }))
})
