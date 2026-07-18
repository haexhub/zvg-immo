// Browser-side Supabase client — talks to GoTrue directly through Kong for
// signup/login/token-refresh (see the plan's trust-boundary note: all other
// data access still goes through the Nuxt server, not this client). Used by
// composables/useAuth.ts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null | undefined

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client
  const config = useRuntimeConfig().public
  const url = config.supabaseUrl as string | undefined
  const anonKey = config.supabaseAnonKey as string | undefined
  client = url && anonKey ? createClient(url, anonKey) : null
  return client
}
