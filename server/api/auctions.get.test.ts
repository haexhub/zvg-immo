import { afterEach, describe, expect, it, vi } from 'vitest'

// Keep the real withStatementTimeout/isStatementTimeoutError/timeout constant
// — only getPool is faked — so the handler's `db.connect()` transaction
// wrapping runs for real against the mock client built in each test.
vi.mock('~/server/utils/db', async () => {
  const actual = await vi.importActual<typeof import('~/server/utils/db')>('~/server/utils/db')
  return { ...actual, getPool: vi.fn() }
})

/** A pool-like object that hands out a fresh mock client per `connect()`
 *  call — one per withStatementTimeout invocation, mirroring a real pool —
 *  whose control statements (BEGIN/SET LOCAL/COMMIT/ROLLBACK) are no-ops,
 *  delegating everything else to `query`. `clients` collects every client
 *  handed out, so a test can assert how many separate connections a handler
 *  actually checked out. */
function mockPool(query: (sql: string, params: unknown[]) => Promise<unknown>) {
  const clients: Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = []
  const connect = vi.fn(async () => {
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
    clients.push(client)
    return client
  })
  return { connect, clients }
}
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
      // Typed auction_details columns.
      property_type: 'einfamilienhaus',
      land_area_sqm: '500',
      living_area_sqm: '120',
      year_built: 1990,
      last_renovation_year: 2020,
      condition: 'gut',
      features: ['garage'],
      extraction_source: 'llm',
      llm_analyzed_at: '2026-07-01T00:00:00.000Z',
      // Curated photos come from auction_photos joined to auction_details.
      // models photo_count/thumbnail_url but not the array itself.
      photos: [
        { file: 'second.jpg', category: 'innen', caption: null, isPropertyPhoto: true },
        { file: 'first.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
      ],
      document_summary: 'Must not reach a search card',
      insights: { defects: ['Must not reach a search card'] },
      // Simulate detail-only fields accidentally present in a DB result.
      description: 'Must not reach a search card',
      attachments: [{ proxyUrl: 'https://example.test/document.pdf' }],
      photo_urls: ['/one.jpg', '/two.jpg'],
      detail_url: 'https://example.test/detail',
    }
    // The facet/stats queries are matched before the row query: every one of
    // them now contains an ORDER BY ... LIMIT from the auction_details lateral
    // join, so that alone no longer identifies the paginated row query.
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('count(*)::int AS total')) {
        return { rows: [{ total: 61, active: 60, cancelled: 1 }], rowCount: 1 }
      }
      if (sql.includes('SELECT DISTINCT a.authority')) {
        return { rows: [{ authority: 'AG München' }], rowCount: 1 }
      }
      if (sql.includes('SELECT d.property_type AS id')) {
        return { rows: [{ id: 'einfamilienhaus', count: 61 }], rowCount: 1 }
      }
      if (sql.includes('LIMIT $') && sql.includes('OFFSET $')) {
        expect(params.at(-2)).toBe(30)
        expect(params.at(-1)).toBe(30)
        return { rows: [row], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
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

  it('runs the four facet queries as four independent connections instead of serializing them on one', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const query = vi.fn(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0, active: 0, cancelled: 0 }] }
      if (sql.includes('SELECT DISTINCT a.authority')) return { rows: [] }
      if (sql.includes('SELECT d.property_type AS id')) return { rows: [] }
      if (sql.includes('LIMIT $') && sql.includes('OFFSET $')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    const pool = mockPool(query)
    vi.mocked(getPool).mockReturnValue(pool as never)
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    await handler({})

    // One connect() per facet query — bundling all four onto one connection
    // would serialize them (a connection only processes one statement at a
    // time) and let their SET LOCAL statement_timeout windows add up instead
    // of capping the whole request at SEARCH_STATEMENT_TIMEOUT_MS.
    expect(pool.connect).toHaveBeenCalledTimes(4)
    expect(pool.clients).toHaveLength(4)
    for (const client of pool.clients) {
      expect(client.release).toHaveBeenCalledOnce()
    }
  })

  it('skips the two facet queries and their connections when skipFacets is set', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de', skipFacets: '1' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const query = vi.fn(async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return { rows: [{ total: 0, active: 0, cancelled: 0 }] }
      if (sql.includes('LIMIT $') && sql.includes('OFFSET $')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    const pool = mockPool(query)
    vi.mocked(getPool).mockReturnValue(pool as never)
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    const result = await handler({})

    expect(result).toMatchObject({ facets: { authorities: [], categories: [] } })
    // Only the row and stats queries open a connection — the facet queries
    // never run, so pool.connect() is called twice instead of four times.
    expect(pool.connect).toHaveBeenCalledTimes(2)
  })

  it('fails visibly when the serving database is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })

  it('translates a statement_timeout cancellation into a 503 instead of a raw 500', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const query = vi.fn(async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(mockPool(query) as never)
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })
})
