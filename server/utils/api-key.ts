// Self-service API keys for the Daten-API (/api/data/v1/*). Plaintext is
// generated once at creation time (server/api/api-keys/index.post.ts) and
// never stored — only its SHA-256 hash (unique-indexed lookup) and an 8-char
// prefix for display survive.

import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { getServiceClient } from './supabase'

export interface GeneratedApiKey {
  /** Shown to the caller exactly once. Never persisted. */
  plaintext: string
  /** SHA-256 hex digest of `plaintext` — stored in api_keys.key_hash. */
  hash: string
  /** First 8 chars of `plaintext` — stored in api_keys.key_prefix so a user
   *  can recognize a key in a list without ever seeing the secret again. */
  prefix: string
}

const PREFIX_LEN = 8

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `zvg_${randomBytes(24).toString('base64url')}`
  return { plaintext, hash: hashApiKey(plaintext), prefix: plaintext.slice(0, PREFIX_LEN) }
}

export interface ApiKeyRecord {
  id: string
  user_id: string
}

/** Verifies the request's `Authorization: Bearer <key>` header against
 *  api_keys.key_hash (active keys only), touches last_used_at, and returns
 *  the (id, user_id) pair. Returns null when the header is missing/malformed,
 *  the key is unknown/inactive, or Supabase isn't configured — callers 401 on
 *  null (see server/middleware/data-api-auth.ts). */
export async function getApiKeyRecord(event: H3Event): Promise<ApiKeyRecord | null> {
  const auth = getRequestHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  const token = match?.[1]
  if (!token) return null
  const supabase = getServiceClient()
  if (!supabase) return null

  const hash = hashApiKey(token)
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, user_id')
    .eq('key_hash', hash)
    .eq('active', true)
    .maybeSingle()
  if (error || !data) return null

  const record: ApiKeyRecord = { id: data.id as string, user_id: data.user_id as string }
  // Best-effort — a failed last_used_at touch shouldn't fail the request that
  // triggered it.
  const { error: touchError } = await supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', record.id)
  if (touchError) {
    console.warn(`[api-key] last_used_at update failed: ${touchError.message}`)
  }
  return record
}
