import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/geocode', () => ({
  geocodeAddress: vi.fn(),
  geocodeStatus: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/auctions-geo', () => {
  it('returns markers only and never leaks card or detail data', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', fetch: '0' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const query = vi.fn().mockResolvedValue({
      rows: [{
        platform: 'zvg-portal',
        external_id: '42',
        country: 'de',
        region: 'Bayern',
        address: 'Musterstraße 1',
        lat: '48.137',
        lng: '11.575',
        title: 'Must not reach the map',
        description: 'Must not reach the map',
        thumbnail_url: '/private.jpg',
      }],
      rowCount: 1,
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./auctions-geo.get')).default as unknown as (
      event: { node: { req: { on: (name: string, callback: () => void) => void } } }
    ) => Promise<unknown>

    const result = await handler({ node: { req: { on: vi.fn() } } })
    expect(result).toMatchObject({
      total: 1,
      geocodedCount: 1,
      auctions: [{
        platform: 'zvg-portal',
        externalId: '42',
        country: 'de',
        region: 'Bayern',
        lat: 48.137,
        lng: 11.575,
      }],
    })
    const marker = (result as { auctions: Array<Record<string, unknown>> }).auctions[0]!
    expect(Object.keys(marker).sort()).toEqual([
      'country', 'externalId', 'lat', 'lng', 'platform', 'region',
    ])
  })
})
