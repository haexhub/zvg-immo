import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/geo-metrics POST', () => {
  it('starts the rebuild chain and returns immediately, without waiting for it to finish', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    let resolveGeoFeatures!: () => void
    const runTask = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveGeoFeatures = () => resolve({ result: {} }) }))
      .mockResolvedValueOnce({ result: {} })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./geo-metrics.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(runTask).toHaveBeenNthCalledWith(1, 'build-geo-features')

    resolveGeoFeatures()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runTask).toHaveBeenNthCalledWith(2, 'build-auction-geo-metrics')
  })

  it('logs instead of throwing when the rebuild chain fails', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const runTask = vi.fn().mockRejectedValueOnce(new Error('boom'))
    vi.stubGlobal('runTask', runTask)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handler = (await import('./geo-metrics.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ started: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errorSpy).toHaveBeenCalledWith('[settings/geo-metrics] rebuild chain failed:', 'boom')
  })
})
