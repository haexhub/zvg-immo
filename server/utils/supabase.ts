// Server-side Supabase access for the saved-searches/watchlist routes.
// Uses the service-role key (bypasses RLS) — same trust-boundary convention
// as the rest of the app: the Nuxt server is the only thing that talks to
// the data layer, the browser never gets a direct, unscoped client for this.
// RLS stays enabled on the tables themselves as defense-in-depth (see
// server/db/schema/), just not exercised via this key.

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { H3Event } from 'h3'

declare module 'h3' {
  interface H3EventContext {
    /** Set by server/middleware/supabase-auth.ts once the caller's Supabase
     *  access token has been verified. Only present on guarded routes. */
    user?: User
  }
}

let client: SupabaseClient | null | undefined

export function getServiceClient(): SupabaseClient | null {
  if (client !== undefined) return client
  const config = useRuntimeConfig()
  const url = config.supabaseUrl as string | undefined
  const serviceKey = config.supabaseServiceRoleKey as string | undefined
  client = url && serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null
  return client
}

/** Verifies the request's `Authorization: Bearer <token>` against GoTrue via
 *  the service client. Returns null when the header is missing/malformed,
 *  the token is invalid, or Supabase isn't configured — callers 401 on null. */
export async function getUserFromEvent(event: H3Event): Promise<User | null> {
  const auth = getRequestHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  if (!match) return null
  const supabase = getServiceClient()
  if (!supabase) return null
  const { data, error } = await supabase.auth.getUser(match[1])
  if (error || !data.user) return null
  return data.user
}
