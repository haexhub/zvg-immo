// Mirrors useCurrencyPreference.ts's cookie+account sync, but for the color
// theme. 'system' defers to the OS preference, which SSR can't know — the
// media-query listener below only runs client-side, so a 'system' pick can
// render light-then-dark for one frame if the OS prefers dark.
import { getSupabaseClient } from '~/lib/supabase-client'

export type ThemePreference = 'light' | 'dark' | 'system'
const SUPPORTED_THEMES = new Set<ThemePreference>(['light', 'dark', 'system'])

export function useThemePreference() {
  const theme = useCookie<ThemePreference>('zvg_theme', {
    default: () => 'system',
    maxAge: 60 * 60 * 24 * 365,
  })
  const systemPrefersDark = useState('theme-preference-system-dark', () => false)
  const { user } = useAuth()
  const ready = useState('theme-preference-ready', () => false)

  function init(): void {
    if (ready.value) return
    ready.value = true
    watch(
      user,
      (u) => {
        const preferred = u?.user_metadata?.theme
        if (typeof preferred === 'string' && SUPPORTED_THEMES.has(preferred as ThemePreference) && preferred !== theme.value) {
          theme.value = preferred as ThemePreference
        }
      },
      { immediate: true },
    )
    if (typeof window !== 'undefined') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      systemPrefersDark.value = mql.matches
      mql.addEventListener('change', (e) => {
        systemPrefersDark.value = e.matches
      })
    }
  }

  /** Explicit switcher action: applies immediately (persisted via cookie for
   *  everyone) and, when signed in, also writes it to the account so it
   *  follows the user elsewhere — same pattern as setPreferredCurrency(). */
  async function setPreferredTheme(value: ThemePreference): Promise<void> {
    theme.value = value
    if (user.value) {
      const client = getSupabaseClient()
      await client?.auth.updateUser({ data: { theme: value } })
    }
  }

  init()

  const isDark = computed(() => theme.value === 'dark' || (theme.value === 'system' && systemPrefersDark.value))

  return { theme, setPreferredTheme, isDark }
}
