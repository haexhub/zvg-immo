import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/fr-dvf-cache', () => {
  it('passes a valid import payload to the task helper', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({
      csvPath: '/data/dvf.csv',
      cachePath: '/cache/fr-dvf.json',
      sourceVersion: 'dvf-2025',
      generatedAt: '2026-07-26T00:00:00.000Z',
    })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const runTask = vi.fn().mockResolvedValue({ result: {
      csvPath: '/data/dvf.csv',
      cachePath: '/cache/fr-dvf.json',
      sourceVersion: 'dvf-2025',
      rows: 2,
      normalized: 1,
      dropped: 1,
      generatedAt: '2026-07-26T00:00:00.000Z',
    } })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./fr-dvf-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toMatchObject({ normalized: 1 })
    expect(runTask).toHaveBeenCalledWith('import-fr-dvf-cache', {
      payload: {
        csvPath: '/data/dvf.csv',
        cachePath: '/cache/fr-dvf.json',
        sourceVersion: 'dvf-2025',
        generatedAt: '2026-07-26T00:00:00.000Z',
      },
    })
  })

  it('rejects a missing csvPath', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ csvPath: ' ' })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./fr-dvf-cache.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
