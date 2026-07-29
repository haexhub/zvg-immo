import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/enrichment', () => {
  it('runs external enrichment with an optional limit', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ limit: 25, country: 'se' })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const runTask = vi.fn().mockResolvedValue({ result: {
      processed: 25,
      written: 10,
      skippedMissingCoordinates: 0,
      marketComparisons: 10,
      landValueBaselines: 0,
      hazards: 0,
      locationContexts: 0,
      staleResults: 0,
      providerFailures: 0,
      durationMs: 123,
    } })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toMatchObject({ processed: 25 })
    expect(runTask).toHaveBeenCalledWith('external-enrichment', {
      payload: {
        limit: 25,
        country: 'se',
        platform: undefined,
        externalId: undefined,
      },
    })
  })

  it('rejects an invalid limit', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ limit: 0 })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
