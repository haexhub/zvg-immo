// Creates a new API key for the caller. The plaintext key is returned here
// and ONLY here — it is never stored (only its hash + prefix, see
// server/utils/api-key.ts) and this response is the one chance the client
// gets to see it. Subsequent GET /api/api-keys only ever shows the prefix.

import { generateApiKey } from '../../utils/api-key'
import { getServiceClient } from '../../utils/supabase'
import type { ApiKeySummary } from './index.get'

export interface CreatedApiKey extends ApiKeySummary {
  /** The full API key. Shown once, right after creation — not retrievable
   *  afterwards. */
  plaintext: string
}

export default defineEventHandler(async (event): Promise<CreatedApiKey> => {
  const body = await readBody<{ label?: unknown }>(event).catch(() => ({}) as { label?: unknown })
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label) {
    throw createError({ statusCode: 400, statusMessage: 'Label fehlt.' })
  }
  if (label.length > 100) {
    throw createError({ statusCode: 400, statusMessage: 'Label ist zu lang (max. 100 Zeichen).' })
  }

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }

  const { plaintext, hash, prefix } = generateApiKey()
  const { data, error } = await supabase
    .from('api_keys')
    .insert({ user_id: event.context.user!.id, label, key_hash: hash, key_prefix: prefix })
    .select('id, label, key_prefix, active, created_at, last_used_at')
    .single()
  if (error || !data) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Anlegen fehlgeschlagen.' })
  }

  return {
    id: data.id as string,
    label: data.label as string,
    keyPrefix: data.key_prefix as string,
    active: data.active as boolean,
    createdAt: data.created_at as string,
    lastUsedAt: data.last_used_at as string | null,
    plaintext,
  }
})
