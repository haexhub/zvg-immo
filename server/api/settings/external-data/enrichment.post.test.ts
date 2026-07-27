import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/tasks/external-enrichment', () => ({ runExternalEnrichment: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/enrichment', () => {
  it('runs external enrichment with an optional limit', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({
      limit: 25,
      providerRateLimits: { 'hazard:effis-wildfire-file-cache': 250 },
    })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { runExternalEnrichment } = await import('~/server/tasks/external-enrichment')
    vi.mocked(runExternalEnrichment).mockResolvedValue({
      processed: 25,
      written: 10,
      skippedMissingCoordinates: 0,
      marketComparisons: 10,
      landValueBaselines: 0,
      hazards: 0,
      staleResults: 0,
      providerFailures: 0,
      providers: [],
      durationMs: 123,
    })

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toMatchObject({ processed: 25 })
    expect(runExternalEnrichment).toHaveBeenCalledWith({
      limit: 25,
      providerRateLimits: { 'hazard:effis-wildfire-file-cache': 250 },
    })
  })

  it('rejects an invalid limit', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ limit: 0 })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects invalid provider rate limits', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ providerRateLimits: { effis: -1 } })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
