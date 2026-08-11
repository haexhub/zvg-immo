import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/eu-flood-risk-cache', () => {
  it('starts the import detached and passes a valid payload to the task helper', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({
      cachePath: '/cache/eu-flood-risk.geojson',
      serviceUrl: 'https://example.test/MapServer/2',
      sourceVersion: 'flood-v1',
      generatedAt: '2026-07-27T00:00:00.000Z',
      pageSize: 100,
      maxPages: 2,
      countryCodes: ['de', 'FR'],
    })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const runTask = vi.fn().mockResolvedValue({ result: {
      cachePath: '/cache/eu-flood-risk.geojson',
      serviceUrl: 'https://example.test/MapServer/2',
      sourceVersion: 'flood-v1',
      generatedAt: '2026-07-27T00:00:00.000Z',
      fetched: 2,
      normalized: 2,
      pages: 1,
    } })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./eu-flood-risk-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    // Detached: awaiting the paginated EEA layer inside the request is what
    // made this button look like it did nothing.
    await expect(handler({})).resolves.toEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('import-eu-flood-risk-cache', {
      payload: {
        cachePath: '/cache/eu-flood-risk.geojson',
        serviceUrl: 'https://example.test/MapServer/2',
        sourceVersion: 'flood-v1',
        generatedAt: '2026-07-27T00:00:00.000Z',
        pageSize: 100,
        maxPages: 2,
        countryCodes: ['de', 'fr'],
      },
    })
  })

  it('rejects invalid country codes', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ countryCodes: ['deu'] })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./eu-flood-risk-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
