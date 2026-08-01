import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/geocode', () => ({
  geocodeAddress: vi.fn(),
  geocodeStatus: vi.fn(),
}))
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

  it('places an address-less row at the country centroid instead of dropping it', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', fetch: '0' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const query = vi.fn().mockResolvedValue({
      rows: [{
        platform: 'zvg-portal',
        external_id: '43',
        country: 'de',
        region: 'Bayern',
        address: null,
        lat: null,
        lng: null,
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
      // Placed via country-centroid fallback, not a real geocode hit.
      geocodedCount: 0,
      unresolvableCount: 1,
      auctions: [{ platform: 'zvg-portal', externalId: '43', country: 'de', lat: 52.52, lng: 13.405 }],
    })
  })

  it('never trusts a stored (0,0) as a real position and re-geocodes from the address', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', fetch: '0' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const query = vi.fn().mockResolvedValue({
      rows: [{
        platform: 'zvg-portal',
        external_id: '44',
        country: 'de',
        region: 'Bayern',
        address: 'Musterstraße 1',
        lat: '0',
        lng: '0',
      }],
      rowCount: 1,
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const { geocodeAddress } = await import('~/server/utils/geocode')
    vi.mocked(geocodeAddress).mockResolvedValue({ lat: 48.137, lng: 11.575, displayName: 'x' })
    const handler = (await import('./auctions-geo.get')).default as unknown as (
      event: { node: { req: { on: (name: string, callback: () => void) => void } } }
    ) => Promise<unknown>

    const result = await handler({ node: { req: { on: vi.fn() } } })
    expect(result).toMatchObject({
      total: 1,
      geocodedCount: 1,
      unresolvableCount: 0,
      auctions: [{ platform: 'zvg-portal', externalId: '44', lat: 48.137, lng: 11.575 }],
    })
  })
})
