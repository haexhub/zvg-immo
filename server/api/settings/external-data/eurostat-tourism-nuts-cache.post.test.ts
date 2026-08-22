import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/eurostat-tourism-nuts-cache', () => {
  it('starts the import detached and passes a valid payload to the task helper', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({
      cachePath: '/cache/eurostat-tourism-nuts.json',
      generatedAt: '2026-08-22T00:00:00.000Z',
    })))

    const runTask = vi.fn().mockResolvedValue({ result: {
      cachePath: '/cache/eurostat-tourism-nuts.json',
      generatedAt: '2026-08-22T00:00:00.000Z',
      sourceVersion: 'eurostat-tour_occ_nin2-p_km2-gisco-nuts2024-20m',
      regionCount: 242,
      regionsWithData: 231,
    } })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./eurostat-tourism-nuts-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('import-eurostat-tourism-nuts-cache', {
      payload: {
        cachePath: '/cache/eurostat-tourism-nuts.json',
        generatedAt: '2026-08-22T00:00:00.000Z',
      },
    })
  })

  it('starts the import with an empty payload when the body is empty', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({})))
    const runTask = vi.fn().mockResolvedValue({ result: {} })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./eurostat-tourism-nuts-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('import-eurostat-tourism-nuts-cache', { payload: {} })
  })
})
