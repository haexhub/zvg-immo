// Favorites an auction. Idempotent: favoriting something already on the
// watchlist (UNIQUE (user_id, platform, external_id)) returns the existing row
// instead of a 500 — the UI's star toggle can fire this without first
// checking whether the item is already there.

import { getServiceClient } from '../../utils/supabase'
import { publicError } from '../../utils/public-error'
import type { WatchlistItem } from './index.get'

const UNIQUE_VIOLATION = '23505'

export default defineEventHandler(async (event): Promise<WatchlistItem> => {
  const body = await readBody<{
    platform?: unknown
    externalId?: unknown
    authority?: unknown
    caseNumber?: unknown
  }>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : ''
  if (!platform || !externalId) {
    throw createError({ statusCode: 400, statusMessage: 'platform/externalId fehlt.' })
  }
  const authority = typeof body.authority === 'string' ? body.authority : null
  const caseNumber = typeof body.caseNumber === 'string' ? body.caseNumber : null

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const userId = event.context.user!.id
  const { data, error } = await supabase
    .from('watchlist_items')
    .insert({ user_id: userId, platform, external_id: externalId, authority, case_number: caseNumber })
    .select('id, platform, external_id, authority, case_number, created_at')
    .single()

  if (error?.code === UNIQUE_VIOLATION) {
    const existing = await supabase
      .from('watchlist_items')
      .select('id, platform, external_id, authority, case_number, created_at')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('external_id', externalId)
      .single()
    if (existing.error || !existing.data) {
      throw publicError('POST /api/watchlist', 500, 'Speichern fehlgeschlagen.', existing.error)
    }
    return toWatchlistItem(existing.data)
  }
  if (error || !data) {
    throw publicError('POST /api/watchlist', 500, 'Speichern fehlgeschlagen.', error)
  }
  return toWatchlistItem(data)
})

function toWatchlistItem(row: Record<string, unknown>): WatchlistItem {
  return {
    id: row.id as string,
    platform: row.platform as string,
    externalId: row.external_id as string,
    authority: row.authority as string | null,
    caseNumber: row.case_number as string | null,
    createdAt: row.created_at as string,
  }
}
