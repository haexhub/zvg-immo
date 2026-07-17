// Favorites an auction. Idempotent: favoriting something already on the
// watchlist (UNIQUE (user_id, platform, zvg_id)) returns the existing row
// instead of a 500 — the UI's star toggle can fire this without first
// checking whether the item is already there.

import { getServiceClient } from '../../utils/supabase'
import type { WatchlistItem } from './index.get'

const UNIQUE_VIOLATION = '23505'

export default defineEventHandler(async (event): Promise<WatchlistItem> => {
  const body = await readBody<{
    platform?: unknown
    zvgId?: unknown
    amtsgericht?: unknown
    aktenzeichen?: unknown
  }>(event).catch(() => ({}) as Record<string, unknown>)
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  const zvgId = typeof body.zvgId === 'string' ? body.zvgId.trim() : ''
  if (!platform || !zvgId) {
    throw createError({ statusCode: 400, statusMessage: 'platform/zvgId fehlt.' })
  }
  const amtsgericht = typeof body.amtsgericht === 'string' ? body.amtsgericht : null
  const aktenzeichen = typeof body.aktenzeichen === 'string' ? body.aktenzeichen : null

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const userId = event.context.user!.id
  const { data, error } = await supabase
    .from('watchlist_items')
    .insert({ user_id: userId, platform, zvg_id: zvgId, amtsgericht, aktenzeichen })
    .select('id, platform, zvg_id, amtsgericht, aktenzeichen, created_at')
    .single()

  if (error?.code === UNIQUE_VIOLATION) {
    const existing = await supabase
      .from('watchlist_items')
      .select('id, platform, zvg_id, amtsgericht, aktenzeichen, created_at')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('zvg_id', zvgId)
      .single()
    if (existing.error || !existing.data) {
      throw createError({ statusCode: 500, statusMessage: existing.error?.message ?? 'Speichern fehlgeschlagen.' })
    }
    return toWatchlistItem(existing.data)
  }
  if (error || !data) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Speichern fehlgeschlagen.' })
  }
  return toWatchlistItem(data)
})

function toWatchlistItem(row: Record<string, unknown>): WatchlistItem {
  return {
    id: row.id as string,
    platform: row.platform as string,
    zvgId: row.zvg_id as string,
    amtsgericht: row.amtsgericht as string | null,
    aktenzeichen: row.aktenzeichen as string | null,
    createdAt: row.created_at as string,
  }
}
