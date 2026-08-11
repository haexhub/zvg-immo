import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/translation-status', () => ({ readTranslationStatusByCountryAndLanguage: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/translation-status-by-language', () => {
  it('returns country status separated by target language', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { readTranslationStatusByCountryAndLanguage } = await import('~/server/utils/translation-status')
    vi.mocked(readTranslationStatusByCountryAndLanguage).mockResolvedValue({
      se: { de: { done: 3, open: 1, error: 0, total: 4 }, en: { done: 2, open: 0, error: 1, total: 3 } },
    })

    const handler = (await import('./translation-status-by-language.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({
      se: { de: { done: 3, open: 1, error: 0, total: 4 }, en: { done: 2, open: 0, error: 1, total: 3 } },
    })
  })
})
