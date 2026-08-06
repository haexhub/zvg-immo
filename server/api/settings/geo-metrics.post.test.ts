import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/geo-metrics POST', () => {
  it('runs build-geo-features then build-auction-geo-metrics', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const runTask = vi.fn()
      .mockResolvedValueOnce({ result: { epoch: 4, perKind: {}, deletedStale: 0, durationMs: 1000 } })
      .mockResolvedValueOnce({ result: { epoch: 4, candidates: 10, computed: 10, skipped: 0, epochSuperseded: false, durationMs: 500 } })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./geo-metrics.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({
      geoFeatures: { epoch: 4, perKind: {}, deletedStale: 0, durationMs: 1000 },
      auctionGeoMetrics: { epoch: 4, candidates: 10, computed: 10, skipped: 0, epochSuperseded: false, durationMs: 500 },
    })
    expect(runTask).toHaveBeenNthCalledWith(1, 'build-geo-features')
    expect(runTask).toHaveBeenNthCalledWith(2, 'build-auction-geo-metrics')
  })
})
