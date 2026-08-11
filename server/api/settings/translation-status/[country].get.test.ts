import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/translation-status', () => ({ readTranslationStatusList: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/translation-status/[country]', () => {
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
    vi.stubGlobal('getRouterParam', () => 'SE')
    vi.stubGlobal('getQuery', () => ({ bucket: 'open' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readTranslationStatusList } = await import('~/server/utils/translation-status')
    vi.mocked(readTranslationStatusList).mockResolvedValue({ items: [], total: 0 })

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>
    await handler({})

    expect(readTranslationStatusList).toHaveBeenCalledWith('se', 'open', {
      limit: 50, offset: 0, search: '', sort: undefined, direction: 'asc', lang: undefined,
    })
  })

  it('forwards a valid target-language filter', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'SE')
    vi.stubGlobal('getQuery', () => ({ bucket: 'open', lang: 'en' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readTranslationStatusList } = await import('~/server/utils/translation-status')
    vi.mocked(readTranslationStatusList).mockResolvedValue({ items: [], total: 0 })

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>
    await handler({})

    expect(readTranslationStatusList).toHaveBeenCalledWith('se', 'open', {
      limit: 50, offset: 0, search: '', sort: undefined, direction: 'asc', lang: 'en',
    })
  })

  it('rejects a non-string target-language filter instead of broadening the result', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'SE')
    vi.stubGlobal('getQuery', () => ({ bucket: 'open', lang: 123 }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400, statusMessage: 'lang muss de oder en sein.' })
  })
})
