import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchCountryStatusOverview', () => {
  it('keeps the live country cards available when status history cannot be read', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/settings/crawl-status') return Promise.resolve({ de: { done: 1, pending: 0, open: 0, error: 0, total: 1 } })
      if (url === '/api/settings/llm-status') return Promise.resolve({ de: { done: 2, pending: 0, open: 0, error: 0, total: 2 } })
      if (url === '/api/settings/translation-status-by-language') return Promise.resolve({ de: {} })
      if (url === '/api/settings/osm-import') return Promise.resolve({ countries: [{ code: 'de' }] })
      return Promise.reject(new Error('history unavailable'))
    })
    vi.stubGlobal('$fetch', fetchMock)

    const { fetchCountryStatusOverview } = await import('./fetchCountryStatusOverview')

    await expect(fetchCountryStatusOverview()).resolves.toEqual({
      crawl: { de: { done: 1, pending: 0, open: 0, error: 0, total: 1 } },
      llm: { de: { done: 2, pending: 0, open: 0, error: 0, total: 2 } },
      translation: { de: {} }, osm: [{ code: 'de' }], snapshots: [],
    })
  })
})
