import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/copernicus-effis-cache', () => {
  it('triggers the import detached with a valid payload', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({
      cachePath: '/cache/copernicus-effis.json',
      serviceUrl: 'https://example.test/effis',
      sourceVersion: 'effis-v1',
      generatedAt: '2026-07-29T00:00:00.000Z',
      bbox: [-10, 35, 30, 55],
      pageSize: 500,
      maxPages: 3,
    })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const runTask = vi.fn().mockResolvedValue({ result: {} })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./copernicus-effis-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('import-copernicus-effis-cache', {
      payload: {
        cachePath: '/cache/copernicus-effis.json',
        serviceUrl: 'https://example.test/effis',
        sourceVersion: 'effis-v1',
        generatedAt: '2026-07-29T00:00:00.000Z',
        bbox: [-10, 35, 30, 55],
        pageSize: 500,
        maxPages: 3,
      },
    })
  })

  it('does not let a rejected task run reject the request', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({})))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('runTask', vi.fn().mockRejectedValue(new Error('boom')))

    const handler = (await import('./copernicus-effis-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
  })

  it('rejects a malformed bbox', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ bbox: [1, 2, 3] })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./copernicus-effis-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
