import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadComposable(injected: (() => void) | null) {
  vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }))
  vi.stubGlobal('inject', () => injected)
  return await import('./useSettingsError')
}

describe('useSettingsError', () => {
  it('expires the session through a directly passed handler, ahead of an injected one', async () => {
    const injected = vi.fn()
    const direct = vi.fn()
    const { useSettingsError } = await loadComposable(injected)

    const { normalizeSettingsError } = useSettingsError(direct)

    expect(normalizeSettingsError({ statusCode: 401 }, 'fallback')).toBe('settings.sessionExpired')
    expect(direct).toHaveBeenCalledOnce()
    expect(injected).not.toHaveBeenCalled()
  })

  it('falls back to the injected handler and leaves non-401 errors alone', async () => {
    const injected = vi.fn()
    const { useSettingsError } = await loadComposable(injected)

    const { normalizeSettingsError } = useSettingsError()

    expect(normalizeSettingsError({ statusCode: 500, data: { statusMessage: 'boom' } }, 'fallback')).toBe('boom')
    expect(injected).not.toHaveBeenCalled()
    normalizeSettingsError({ statusCode: 401 }, 'fallback')
    expect(injected).toHaveBeenCalledOnce()
  })
})
