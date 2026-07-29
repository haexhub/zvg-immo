import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/tasks/import-copernicus-effis-cache', () => ({ runImportCopernicusEffisCache: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/copernicus-effis-cache', () => {
  it('passes a valid import payload to the task helper', async () => {
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

    const { runImportCopernicusEffisCache } = await import('~/server/tasks/import-copernicus-effis-cache')
    vi.mocked(runImportCopernicusEffisCache).mockResolvedValue({
      cachePath: '/cache/copernicus-effis.json',
      serviceUrl: 'https://example.test/effis',
      sourceVersion: 'effis-v1',
      generatedAt: '2026-07-29T00:00:00.000Z',
      fetched: 2,
      normalized: 2,
      pages: 1,
    })

    const handler = (await import('./copernicus-effis-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toMatchObject({ normalized: 2 })
    expect(runImportCopernicusEffisCache).toHaveBeenCalledWith({
      cachePath: '/cache/copernicus-effis.json',
      serviceUrl: 'https://example.test/effis',
      sourceVersion: 'effis-v1',
      generatedAt: '2026-07-29T00:00:00.000Z',
      bbox: [-10, 35, 30, 55],
      pageSize: 500,
      maxPages: 3,
    })
  })

  it('rejects a malformed bbox', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ bbox: [1, 2, 3] })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./copernicus-effis-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
