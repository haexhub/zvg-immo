import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
// Collaborators of the shared filter builder: the enabled-country scope and the
// admin-configured hideRulesOnly default.
vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['de']),
  getEnabledCountryCodes: vi.fn(() => ['de']),
}))
vi.mock('~/server/utils/app-settings', () => ({
  getHideRulesOnlyAuctions: vi.fn(async () => false),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/auctions', () => {
  it('returns a paginated card DTO without detail text, documents or raw galleries', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', page: '2', pageSize: '30' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const row = {
      platform: 'zvg-portal',
      country: 'de',
      region: 'Bayern',
      external_id: '42',
      case_number: '1 K 1/26',
      authority: 'AG München',
      title: 'Einfamilienhaus',
      address: 'Musterstraße 1',
      market_value: '450000',
      currency: 'EUR',
      market_value_eur: '450000',
      market_value_text: '450.000 EUR',
      starting_bid: null,
      current_bid: null,
      auction_date_iso: '2026-08-01T09:00:00.000Z',
      auction_date_text: '01.08.2026, 09:00',
      cancelled: false,
      photo_count: 4,
      thumbnail_url: '/api/auction-image/zvg-portal/42/first.jpg',
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        yearBuilt: 1990,
        lastRenovationYear: 2020,
        condition: 'gut',
        features: ['garage'],
        photos: [
          { file: 'second.jpg', category: 'innen', caption: null, isPropertyPhoto: true },
          { file: 'first.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
        ],
        source: 'llm',
        llmAnalyzedAt: '2026-07-01T00:00:00.000Z',
        documentSummary: 'Must not reach a search card',
        insights: { defects: ['Must not reach a search card'] },
      },
      // Simulate detail-only fields accidentally present in a DB result.
      description: 'Must not reach a search card',
      attachments: [{ proxyUrl: 'https://example.test/document.pdf' }],
      photo_urls: ['/one.jpg', '/two.jpg'],
      detail_url: 'https://example.test/detail',
    }
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('ORDER BY') && sql.includes('LIMIT')) {
        expect(params.at(-2)).toBe(30)
        expect(params.at(-1)).toBe(30)
        return { rows: [row], rowCount: 1 }
      }
      if (sql.includes('count(*)::int AS total')) {
        return { rows: [{ total: 61, active: 60, cancelled: 1 }], rowCount: 1 }
      }
      if (sql.includes('SELECT DISTINCT a.authority')) {
        return { rows: [{ authority: 'AG München' }], rowCount: 1 }
      }
      if (sql.includes('SELECT a.property_type AS id')) {
        return { rows: [{ id: 'einfamilienhaus', count: 61 }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    const result = await handler({})
    expect(result).toMatchObject({ total: 61, page: 2, pageSize: 30 })
    const card = (result as { auctions: Array<Record<string, unknown>> }).auctions[0]!
    expect(card.thumbnailUrl).toBe('/api/auction-image/zvg-portal/42/first.jpg')
    expect(card.galleryUrls).toEqual([
      '/api/auction-image/zvg-portal/42/first.jpg',
      '/api/auction-image/zvg-portal/42/second.jpg',
    ])
    expect(card).not.toHaveProperty('description')
    expect(card).not.toHaveProperty('attachments')
    expect(card).not.toHaveProperty('photoUrls')
    expect(card).not.toHaveProperty('detailUrl')
    expect(card.extraction).not.toHaveProperty('documentSummary')
    expect(card.extraction).not.toHaveProperty('insights')
    expect(card.extraction).not.toHaveProperty('photos')
  })

  it('fails visibly when the serving database is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })
})
