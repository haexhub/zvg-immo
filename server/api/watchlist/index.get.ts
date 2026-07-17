// Lists the caller's watchlist items.

import { getServiceClient } from '../../utils/supabase'

export interface WatchlistItem {
  id: string
  platform: string
  zvgId: string
  amtsgericht: string | null
  aktenzeichen: string | null
  createdAt: string
}

export default defineEventHandler(async (event): Promise<WatchlistItem[]> => {
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('id, platform, zvg_id, amtsgericht, aktenzeichen, created_at')
    .eq('user_id', event.context.user!.id)
    .order('created_at', { ascending: false })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    platform: row.platform as string,
    zvgId: row.zvg_id as string,
    amtsgericht: row.amtsgericht as string | null,
    aktenzeichen: row.aktenzeichen as string | null,
    createdAt: row.created_at as string,
  }))
})
