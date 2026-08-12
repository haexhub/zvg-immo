import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/crawl-status', () => ({ readCrawlStatusByCountry: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/crawl-status', () => {
  it('returns the per-country aggregate as-is', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { readCrawlStatusByCountry } = await import('~/server/utils/crawl-status')
    vi.mocked(readCrawlStatusByCountry).mockResolvedValue({ de: { done: 5, open: 2, error: 1, pending: 0, total: 8 } })

    const handler = (await import('./crawl-status.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ de: { done: 5, open: 2, error: 1, pending: 0, total: 8 } })
  })
})
