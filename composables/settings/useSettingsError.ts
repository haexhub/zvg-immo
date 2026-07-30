import type { InjectionKey } from 'vue'

export const settingsSessionExpiredKey: InjectionKey<() => void> = Symbol('settingsSessionExpired')

export function useSettingsError() {
  const { t } = useI18n()
  const expireSession = inject(settingsSessionExpiredKey, null)

  function normalizeSettingsError(err: unknown, fallback: string): string {
    if ((err as { statusCode?: number }).statusCode === 401) {
      expireSession?.()
      return t('settings.claude.sessionExpired')
    }
    const e = err as { data?: { statusMessage?: string }; statusMessage?: string; message?: string }
    return e.data?.statusMessage || e.statusMessage || e.message || fallback
  }

  return { normalizeSettingsError }
}
