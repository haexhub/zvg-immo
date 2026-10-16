import { useSettingsError } from './useSettingsError'

// Wraps the pending/error/try-catch-finally boilerplate repeated across
// nearly every settings card's load/save handlers. One instance per
// pending+error pair a card actually has (most cards share one pair across
// load and save, same as before this existed).
export function useSettingsAction() {
  const { t } = useI18n()
  const { normalizeSettingsError } = useSettingsError()

  const pending = ref(false)
  const error = ref<string | null>(null)

  async function run<T>(fn: () => Promise<T>, fallbackErrorKey: string): Promise<T | undefined> {
    pending.value = true
    error.value = null
    try {
      return await fn()
    } catch (err) {
      error.value = normalizeSettingsError(err, t(fallbackErrorKey))
      return undefined
    } finally {
      pending.value = false
    }
  }

  return { pending, error, run }
}
