// Thin $fetch wrapper that attaches the current Supabase access token as a
// Bearer header — used by pages/index.vue and pages/account.vue to call the
// session-guarded /api/saved-searches and /api/watchlist routes (see
// server/middleware/supabase-auth.ts). Client-only: the token lives in
// browser storage, same constraint as composables/useAuth.ts.

import { getSupabaseClient } from '~/lib/supabase-client'

export async function authFetch<T>(url: string, opts: Record<string, unknown> = {}): Promise<T> {
  const client = getSupabaseClient()
  const token = client ? (await client.auth.getSession()).data.session?.access_token : undefined
  const res = await $fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers as Record<string, string> | undefined),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return res as T
}
