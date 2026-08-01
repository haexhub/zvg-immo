import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['de']),
  getEnabledCountryCodes: vi.fn(() => ['de']),
  listCountries: vi.fn(() => [{ code: 'de', name: 'Deutschland', regions: [] }]),
}))
vi.mock('~/server/utils/app-settings', () => ({
  getHideRulesOnlyAuctions: vi.fn(async () => false),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
    extraction: { condition: 'neuwertig', features: [], source: 'llm' },
    ...overrides,
  }
}

describe('/api/landing/rails', () => {
  it('returns country tiles with counts/thumbnails and a best-condition rail', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('DISTINCT ON (a.country)')) {
        return { rows: [row()], rowCount: 1 }
      }
      if (sql.includes('GROUP BY a.country')) {
        return { rows: [{ country: 'de', count: 61 }], rowCount: 1 }
      }
      if (sql.includes('CASE a.condition')) {
        expect(params.at(-1)).toBe(12)
        return { rows: [row({ external_id: '43', extraction: { condition: 'gepflegt', features: [], source: 'llm' } })], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./rails.get')).default as unknown as (event: unknown) => Promise<unknown>

    const result = await handler({}) as {
      countries: Array<{ code: string; name: string; count: number; thumbnailUrl: string | null }>
      bestCondition: Array<{ externalId: string }>
    }

    expect(result.countries).toEqual([
      { code: 'de', name: 'Deutschland', count: 61, thumbnailUrl: '/api/auction-image/zvg-portal/42/first.jpg' },
    ])
    expect(result.bestCondition).toHaveLength(1)
    expect(result.bestCondition[0]!.externalId).toBe('43')
  })

  it('fails visibly when the serving database is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)
    const handler = (await import('./rails.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })
})
