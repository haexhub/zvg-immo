import { afterEach, describe, expect, it, vi } from 'vitest'

// Keep the real withStatementTimeout/isStatementTimeoutError/timeout constant
// — only getPool is faked — so the handler's `db.connect()` transaction
// wrapping runs for real against the mock client built in each test.
vi.mock('~/server/utils/db', async () => {
  const actual = await vi.importActual<typeof import('~/server/utils/db')>('~/server/utils/db')
  return { ...actual, getPool: vi.fn() }
})

/** A pool-like object whose one connection's control statements (BEGIN/SET
 *  LOCAL/COMMIT/ROLLBACK) are no-ops, delegating everything else to `query`. */
function mockPool(query: (sql: string, params: unknown[]) => Promise<unknown>) {
  const client = {
    // withStatementTimeout issues BEGIN/SET LOCAL/COMMIT/ROLLBACK through a
    // Drizzle session now, so those specific calls arrive as a {text, ...}
    // config object instead of a plain string — everything else (this
    // handler's own hand-built SQL) still comes through as a plain string.
    query: vi.fn(async (queryArg: string | { text: string }, params: unknown[] = []) => {
      const sql = typeof queryArg === 'string' ? queryArg : queryArg.text
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
        return { rows: [] }
      }
      return query(sql, params)
    }),
    release: vi.fn(),
  }
  return { connect: vi.fn().mockResolvedValue(client) }
}

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
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
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
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
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
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
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

  it('selects lat/lng from auctions ("a"), not the versioned auction_details ("d")', async () => {
    // WP-0 moved lat/lng off auction_details onto auctions; d.lat/d.lng no
    // longer exists and would 500 every request (undefined_column), not just
    // ones with an active geo filter — this is the map endpoint's own SELECT.
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', fetch: '0' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    let capturedSql = ''
    const query = vi.fn(async (sql: string) => {
      capturedSql = sql
      return { rows: [], rowCount: 0 }
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
    const handler = (await import('./auctions-geo.get')).default as unknown as (
      event: { node: { req: { on: (name: string, callback: () => void) => void } } }
    ) => Promise<unknown>

    await handler({ node: { req: { on: vi.fn() } } })

    expect(capturedSql).toContain('a.lat')
    expect(capturedSql).toContain('a.lng')
    expect(capturedSql).not.toContain('d.lat')
    expect(capturedSql).not.toContain('d.lng')
  })

  it('joins auction_geo_metrics so an active Umgebung filter has its "m" alias', async () => {
    // GIS WP-5: the shared predicate (auction-search-filters.ts) emits
    // `m.dist_sea_m <= $n` for a proximity filter. This endpoint builds its
    // own narrow marker query rather than reusing SUMMARY_FROM_SQL, so
    // without the join every geofiltered map request fails outright
    // (missing_from_clause), not just returns wrong markers.
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', nearSea: '5', fetch: '0' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    let capturedSql = ''
    const query = vi.fn(async (sql: string) => {
      capturedSql = sql
      return { rows: [], rowCount: 0 }
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
    const handler = (await import('./auctions-geo.get')).default as unknown as (
      event: { node: { req: { on: (name: string, callback: () => void) => void } } }
    ) => Promise<unknown>

    await handler({ node: { req: { on: vi.fn() } } })

    expect(capturedSql).toContain('m.dist_sea_m <=')
    expect(capturedSql).toContain('LEFT JOIN auction_geo_metrics m')
  })

  it('translates a statement_timeout cancellation into a 503 instead of a raw 500', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', fetch: '0' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const query = vi.fn(async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
    const handler = (await import('./auctions-geo.get')).default as unknown as (
      event: { node: { req: { on: (name: string, callback: () => void) => void } } }
    ) => Promise<unknown>

    await expect(handler({ node: { req: { on: vi.fn() } } })).rejects.toMatchObject({ statusCode: 503 })
  })
})
