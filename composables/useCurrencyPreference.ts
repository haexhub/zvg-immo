// Mirrors useLocalePreference.ts's cookie+account sync, but for the user's
// display currency (WP-7) — independent of locale (a Swedish user may well
// pick German UI text with SEK amounts). Holds only the currency *code*;
// actual conversion happens in useCurrencyDisplay.ts and never runs
// server-side, so this cookie being read during SSR has no effect on the
// rendered numbers (see that composable's header comment).
import { getSupabaseClient } from '~/lib/supabase-client'

export function useCurrencyPreference() {
  const currency = useCookie<string>('zvg_currency', {
    default: () => 'EUR',
    maxAge: 60 * 60 * 24 * 365,
  })
  const { user } = useAuth()
  const ready = useState('currency-preference-ready', () => false)

  function init(): void {
    // Mirrors useAuth.ts: the account-metadata watch only matters once the
    // client resolves the real session, so `ready` must stay false through
    // SSR — otherwise it's serialized as `true` into the payload and the
    // client skips this watch() entirely on hydration, never syncing.
    if (ready.value || import.meta.server) return
    ready.value = true
    watch(
      user,
      (u) => {
        const preferred = u?.user_metadata?.currency
        if (typeof preferred === 'string' && preferred !== currency.value) {
          currency.value = preferred
        }
      },
      { immediate: true },
    )
  }

  /** Explicit switcher action: applies immediately (persisted via cookie for
   *  everyone) and, when signed in, also writes it to the account so it
   *  follows the user elsewhere — same pattern as setPreferredLocale(). */
  async function setPreferredCurrency(code: string): Promise<void> {
    currency.value = code
    if (user.value) {
      const client = getSupabaseClient()
      await client?.auth.updateUser({ data: { currency: code } })
    }
  }

  init()

  return { currency, setPreferredCurrency }
}
