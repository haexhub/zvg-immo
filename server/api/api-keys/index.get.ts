// Lists the caller's API keys (server/middleware/supabase-auth.ts has already
// verified event.context.user and 401'd otherwise — this is the session-
// guarded management path, distinct from the API-key-guarded /api/data/*
// routes). Never returns key_hash or the plaintext key — only what's needed
// to recognize/manage a key.

import { getServiceClient } from '../../utils/supabase'

export interface ApiKeySummary {
  id: string
  label: string
  keyPrefix: string
  active: boolean
  createdAt: string
  lastUsedAt: string | null
}

export default defineEventHandler(async (event): Promise<ApiKeySummary[]> => {
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, label, key_prefix, active, created_at, last_used_at')
    .eq('user_id', event.context.user!.id)
    .order('created_at', { ascending: false })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    label: row.label as string,
    keyPrefix: row.key_prefix as string,
    active: row.active as boolean,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string | null,
  }))
})
