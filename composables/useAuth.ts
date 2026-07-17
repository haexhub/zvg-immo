// First composable in this project. Wraps the browser Supabase client
// (lib/supabase-client.ts) in a reactive `user` state shared across every
// component via useState, so AuthStatus/login/signup all see the same
// session without re-fetching it.

import type { User } from '@supabase/supabase-js'
import { getSupabaseClient } from '~/lib/supabase-client'

export function useAuth() {
  const user = useState<User | null>('supabase-user', () => null)
  const ready = useState('supabase-auth-ready', () => false)

  function init(): void {
    // Session persistence relies on browser storage — skip entirely during
    // SSR so it runs exactly once, on the client after hydration.
    if (ready.value || import.meta.server) return
    ready.value = true
    const client = getSupabaseClient()
    if (!client) return
    client.auth.getSession().then(({ data }) => {
      user.value = data.session?.user ?? null
    })
    client.auth.onAuthStateChange((_event, session) => {
      user.value = session?.user ?? null
    })
  }

  async function signUp(email: string, password: string) {
    const client = getSupabaseClient()
    if (!client) return { error: new Error('Supabase ist nicht konfiguriert.') }
    const { error } = await client.auth.signUp({ email, password })
    return { error }
  }

  async function signIn(email: string, password: string) {
    const client = getSupabaseClient()
    if (!client) return { error: new Error('Supabase ist nicht konfiguriert.') }
    const { error } = await client.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signOut() {
    const client = getSupabaseClient()
    if (!client) return
    await client.auth.signOut()
    user.value = null
  }

  init()

  return { user, signUp, signIn, signOut }
}
