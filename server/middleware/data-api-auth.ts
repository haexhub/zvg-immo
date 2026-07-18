// Guards /api/data/* (the versioned self-service Daten-API namespace) — a
// separate auth path from server/middleware/supabase-auth.ts's browser-session
// guard, which does not cover this prefix. Verifies a Bearer API key
// (server/utils/api-key.ts), enforces a burst rate limit via the existing
// in-memory limiter (keyed per api_keys.id, not per IP — a key is the unit of
// identity here), and counts usage in api_usage for a later billing phase.

import { getApiKeyRecord } from '../utils/api-key'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '../utils/in-memory-rate-limit'
import { getServiceClient } from '../utils/supabase'

declare module 'h3' {
  interface H3EventContext {
    /** Set by this middleware once the caller's API key has been verified.
     *  Only present on /api/data/* routes. */
    apiKey?: { id: string; userId: string }
  }
}

// Burst protection only — this is process-local and resets on restart (fine
// for the current single-container deployment, see the plan's caveat on
// in-memory-rate-limit.ts). Volume accounting for the later billing phase
// lives in api_usage below, counted independently of this limit.
const BURST_LIMIT = { max: 60, windowMs: 60 * 1000, maxKeys: 10_000 }
const burstState = createInMemoryRateLimitState()

export default defineEventHandler(async (event) => {
  const path = (event.node.req.url ?? '').split('?')[0]!
  if (!path.startsWith('/api/data/')) return

  const record = await getApiKeyRecord(event)
  if (!record) {
    throw createError({ statusCode: 401, statusMessage: 'Ungültiger oder fehlender API-Key.' })
  }

  const now = Date.now()
  if (!checkInMemoryRateLimit(burstState, record.id, now, BURST_LIMIT)) {
    throw createError({ statusCode: 429, statusMessage: 'Rate limit überschritten.' })
  }
  recordInMemoryRateLimitHit(burstState, record.id, now, BURST_LIMIT)

  event.context.apiKey = { id: record.id, userId: record.user_id }
  await recordApiUsage(record.id)
})

// Counts today's requests for this key. Best-effort read-modify-write:
// api_usage backs a future billing feature, not a security boundary, so the
// race window on concurrent requests for the same key+day (narrowed further
// by the burst limit above) is an acceptable trade-off against adding a raw
// atomic-increment path just for this counter.
async function recordApiUsage(apiKeyId: string): Promise<void> {
  const supabase = getServiceClient()
  if (!supabase) return
  const day = new Date().toISOString().slice(0, 10)
  try {
    const { data, error: selectError } = await supabase
      .from('api_usage')
      .select('count')
      .eq('api_key_id', apiKeyId)
      .eq('day', day)
      .maybeSingle()
    if (selectError) throw selectError
    if (data) {
      const { error: updateError } = await supabase
        .from('api_usage')
        .update({ count: (data.count as number) + 1 })
        .eq('api_key_id', apiKeyId)
        .eq('day', day)
      if (updateError) throw updateError
    } else {
      const { error: insertError } = await supabase
        .from('api_usage')
        .insert({ api_key_id: apiKeyId, day, count: 1 })
      if (insertError) throw insertError
    }
  } catch (err) {
    console.warn(`[data-api-auth] api_usage update failed: ${(err as Error).message}`)
  }
}
