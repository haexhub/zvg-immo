// Keeps the vue-i18n locale in sync with the logged-in user's account
// preference (Supabase `user_metadata.locale`). Anonymous persistence is
// handled separately by @nuxtjs/i18n's own cookie (see nuxt.config.ts
// i18n.detectBrowserLanguage) — this composable only takes over once a user
// is signed in, so their choice follows them across browsers/devices.
import { getSupabaseClient } from '~/lib/supabase-client'

const SUPPORTED_LOCALES = new Set(['de', 'en'])

// @nuxtjs/i18n augments the runtime Composer with setLocale (applies the
// cookie-persisted switch) — this project's generated .nuxt/types don't pick
// up that augmentation (a runtime/types.ts import-path quirk in the
// installed version), so the method exists but isn't in the static type.
interface I18nWithSetLocale {
  setLocale: (locale: string) => Promise<void>
}

export function useLocalePreference() {
  const i18n = useI18n()
  const { locale } = i18n
  const setLocale = (code: string) => (i18n as unknown as I18nWithSetLocale).setLocale(code)
  const { user } = useAuth()
  const ready = useState('locale-preference-ready', () => false)

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
        const preferred = u?.user_metadata?.locale
        if (typeof preferred === 'string' && SUPPORTED_LOCALES.has(preferred) && preferred !== locale.value) {
          setLocale(preferred as 'de' | 'en')
        }
      },
      { immediate: true },
    )
  }

  /** Explicit switcher action: applies the locale immediately (persisted via
   *  the i18n cookie for everyone) and, when signed in, also writes it to the
   *  account so it follows the user elsewhere. */
  async function setPreferredLocale(code: 'de' | 'en'): Promise<void> {
    await setLocale(code)
    if (user.value) {
      const client = getSupabaseClient()
      await client?.auth.updateUser({ data: { locale: code } })
    }
  }

  init()

  return { setPreferredLocale }
}
