import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/tasks/import-effis-wildfire-cache', () => ({ runImportEffisWildfireCache: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/effis-wildfire-cache', () => {
  it('passes a valid import payload to the task helper', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({
      cachePath: '/cache/effis-wildfire.json',
      serviceUrl: 'https://example.test/gwis',
      sourceVersion: 'effis-v1',
      generatedAt: '2026-07-26T06:00:00.000Z',
      validFor: '2026-07-26',
      ttlHours: 24,
      points: [{ id: 'test:42', lat: 48.8566, lng: 2.3522 }],
    })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const { runImportEffisWildfireCache } = await import('~/server/tasks/import-effis-wildfire-cache')
    vi.mocked(runImportEffisWildfireCache).mockResolvedValue({
      cachePath: '/cache/effis-wildfire.json',
      serviceUrl: 'https://example.test/gwis',
      sourceVersion: 'effis-v1',
      generatedAt: '2026-07-26T06:00:00.000Z',
      validFor: '2026-07-26',
      requested: 1,
      sampled: 1,
    })

    const handler = (await import('./effis-wildfire-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toMatchObject({ sampled: 1 })
    expect(runImportEffisWildfireCache).toHaveBeenCalledWith({
      cachePath: '/cache/effis-wildfire.json',
      serviceUrl: 'https://example.test/gwis',
      sourceVersion: 'effis-v1',
      generatedAt: '2026-07-26T06:00:00.000Z',
      validFor: '2026-07-26',
      ttlHours: 24,
      points: [{ id: 'test:42', lat: 48.8566, lng: 2.3522 }],
    })
  })

  it('rejects invalid coordinates', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ points: [{ lat: 100, lng: 2 }] })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./effis-wildfire-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
