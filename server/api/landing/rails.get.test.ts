import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['se', 'de', 'bg']),
  getEnabledCountryCodes: vi.fn(() => ['se', 'de', 'bg']),
  listCountries: vi.fn(() => [
    { code: 'de', name: 'Deutschland', regions: [] },
    { code: 'se', name: 'Schweden', regions: [] },
    { code: 'bg', name: 'Bulgarien', regions: [] },
  ]),
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
  it('returns country rails (skipping empty ones), a best-condition rail and geo rails', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('CASE a.condition')) {
        expect(params.at(-1)).toBe(12)
        return { rows: [row({ external_id: '43', extraction: { condition: 'gepflegt', features: [], source: 'llm' } })], rowCount: 1 }
      }
      if (sql.includes('osm_local_elements')) {
        expect(params.at(-1)).toBe(12)
        const tagValue = params[2]
        const byTagValue: Record<string, ReturnType<typeof row>[]> = {
          coastline: [row({ external_id: '10' })],
          peak: [row({ external_id: '11' })],
          water: [row({ external_id: '12' })],
          river: [row({ external_id: '13' })],
        }
        const rows = byTagValue[tagValue as string]
        if (!rows) throw new Error(`unexpected geo tag value: ${String(tagValue)}`)
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('a.country = ANY(')) {
        const code = (params[0] as string[])[0]
        if (code === 'se') return { rows: [row({ external_id: '1', country: 'se' })], rowCount: 1 }
        if (code === 'de') return { rows: [row({ external_id: '2', country: 'de' })], rowCount: 1 }
        if (code === 'bg') return { rows: [], rowCount: 0 }
        throw new Error(`unexpected country: ${code}`)
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./rails.get')).default as unknown as (event: unknown) => Promise<unknown>

    const result = await handler({}) as {
      countryRails: Array<{ code: string; name: string; auctions: Array<{ externalId: string }> }>
      bestCondition: Array<{ externalId: string }>
      sea: Array<{ externalId: string }>
      mountains: Array<{ externalId: string }>
      lakes: Array<{ externalId: string }>
      rivers: Array<{ externalId: string }>
    }

    expect(result.countryRails).toHaveLength(2)
    expect(result.countryRails[0]).toMatchObject({ code: 'se', name: 'Schweden' })
    expect(result.countryRails[0]!.auctions[0]!.externalId).toBe('1')
    expect(result.countryRails[1]).toMatchObject({ code: 'de', name: 'Deutschland' })
    expect(result.countryRails.some((r) => r.code === 'bg')).toBe(false)

    expect(result.bestCondition).toHaveLength(1)
    expect(result.bestCondition[0]!.externalId).toBe('43')

    expect(result.sea[0]!.externalId).toBe('10')
    expect(result.mountains[0]!.externalId).toBe('11')
    expect(result.lakes[0]!.externalId).toBe('12')
    expect(result.rivers[0]!.externalId).toBe('13')
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
