import type { InjectionKey } from 'vue'

export const settingsSessionExpiredKey: InjectionKey<() => void> = Symbol('settingsSessionExpired')

// A component providing settingsSessionExpiredKey cannot inject its own
// provide (Vue only looks at ancestors), so a page that owns the auth state
// passes its expiry handler directly.
export function useSettingsError(onSessionExpired?: () => void) {
  const { t } = useI18n()
  const expireSession = onSessionExpired ?? inject(settingsSessionExpiredKey, null)

  function normalizeSettingsError(err: unknown, fallback: string): string {
    const e = typeof err === 'object' && err !== null
      ? err as { statusCode?: number; data?: { statusMessage?: string }; statusMessage?: string; message?: string }
      : {}
    if (e.statusCode === 401) {
      expireSession?.()
      return t('settings.sessionExpired')
    }
    return e.data?.statusMessage || e.statusMessage || e.message || fallback
  }

  return { normalizeSettingsError }
}
