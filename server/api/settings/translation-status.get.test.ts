import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/translation-status', () => ({ readTranslationStatusByCountry: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/translation-status', () => {
  it('returns the per-country aggregate as-is', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { readTranslationStatusByCountry } = await import('~/server/utils/translation-status')
    vi.mocked(readTranslationStatusByCountry).mockResolvedValue({ de: { done: 4, open: 1, error: 2, pending: 0, total: 7 } })

    const handler = (await import('./translation-status.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ de: { done: 4, open: 1, error: 2, pending: 0, total: 7 } })
  })
})
