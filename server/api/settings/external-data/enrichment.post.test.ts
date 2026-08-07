import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/external-data/enrichment', () => {
  it('triggers external enrichment detached with an optional limit', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({ limit: 25, country: 'se' })))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const runTask = vi.fn().mockResolvedValue({ result: {} })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('external-enrichment', {
      payload: {
        limit: 25,
        country: 'se',
        platform: undefined,
        externalId: undefined,
      },
    })
  })

  it('does not let a rejected task run reject the request', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({})))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('runTask', vi.fn().mockRejectedValue(new Error('boom')))

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
  })

  it('starts an unscoped run when the request has no body', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => undefined))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const runTask = vi.fn().mockResolvedValue({ result: {} })
    vi.stubGlobal('runTask', runTask)

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('external-enrichment', {
      payload: {
        limit: undefined,
        country: undefined,
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
