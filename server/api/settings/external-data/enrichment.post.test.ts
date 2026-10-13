import { afterEach, describe, expect, it, vi } from 'vitest'
import { runExternalEnrichmentTask } from '~/server/tasks/external-enrichment'

vi.mock('~/server/tasks/external-enrichment', () => ({ runExternalEnrichmentTask: vi.fn() }))

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
    vi.mocked(runExternalEnrichmentTask).mockResolvedValue({})

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
    expect(runExternalEnrichmentTask).toHaveBeenCalledWith({
      limit: 25,
      country: 'se',
      platform: undefined,
      externalId: undefined,
      trigger: 'manual',
    })
  })

  it('does not let a rejected task run reject the request', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => ({})))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.mocked(runExternalEnrichmentTask).mockRejectedValue(new Error('boom'))

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
  })

  it('starts an unscoped run when the request has no body', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', vi.fn(async () => undefined))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.mocked(runExternalEnrichmentTask).mockResolvedValue({})

    const handler = (await import('./enrichment.post')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toStrictEqual({ started: true })
    expect(runExternalEnrichmentTask).toHaveBeenCalledWith({
      limit: undefined,
      country: undefined,
      platform: undefined,
      externalId: undefined,
      trigger: 'manual',
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
