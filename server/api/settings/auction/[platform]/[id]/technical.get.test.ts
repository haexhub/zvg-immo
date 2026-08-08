import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-technical', () => ({ readAuctionTechnicalOverview: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/auction/[platform]/[id]/technical', () => {
  it('rejects an unsafe platform/id segment', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? '../etc' : '7265'))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./technical.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the identity does not exist', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : 'missing'))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readAuctionTechnicalOverview } = await import('~/server/utils/auction-technical')
    vi.mocked(readAuctionTechnicalOverview).mockResolvedValue(null)

    const handler = (await import('./technical.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns the aggregated overview for a known identity', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_event: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readAuctionTechnicalOverview } = await import('~/server/utils/auction-technical')
    const overview = { identity: { platform: 'zvg-portal', externalId: '7265' } } as never
    vi.mocked(readAuctionTechnicalOverview).mockResolvedValue(overview)

    const handler = (await import('./technical.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toBe(overview)
    expect(readAuctionTechnicalOverview).toHaveBeenCalledWith('zvg-portal', '7265')
  })
})
