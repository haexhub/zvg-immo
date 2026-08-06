import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/geo-metrics GET', () => {
  it('reports row counts and the latest epoch', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: '1234' }] })
      .mockResolvedValueOnce({ rows: [{ epoch: 3, completed_at: '2026-08-06T02:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [{ count: '567' }] })
    vi.stubGlobal('getPool', vi.fn(() => ({ query })))

    const handler = (await import('./geo-metrics.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({
      geoFeaturesRows: 1234,
      latestEpoch: 3,
      latestEpochCompletedAt: '2026-08-06T02:00:00.000Z',
      auctionGeoMetricsRows: 567,
    })
  })

  it('returns zeroed status when no database is configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getPool', vi.fn(() => null))

    const handler = (await import('./geo-metrics.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({
      geoFeaturesRows: 0,
      latestEpoch: null,
      latestEpochCompletedAt: null,
      auctionGeoMetricsRows: 0,
    })
  })
})
