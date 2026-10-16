import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/crawl-status', () => ({ readCrawlStatusList: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/crawl-status/[country]', () => {
  it('rejects an invalid bucket', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'de')
    vi.stubGlobal('getQuery', () => ({ bucket: 'nonsense' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('forwards country/bucket and clamps limit/offset defaults', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'DE')
    vi.stubGlobal('getQuery', () => ({ bucket: 'error' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readCrawlStatusList } = await import('~/server/utils/crawl-status')
    vi.mocked(readCrawlStatusList).mockResolvedValue({ items: [], total: 0 })

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>
    await handler({})

    expect(readCrawlStatusList).toHaveBeenCalledWith('de', 'error', { limit: 50, offset: 0 })
  })

  it('rejects a fractional limit', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'de')
    vi.stubGlobal('getQuery', () => ({ bucket: 'error', limit: '1.5' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a fractional offset', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'de')
    vi.stubGlobal('getQuery', () => ({ bucket: 'error', offset: '1.5' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
