import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecord: vi.fn() }))

function auction(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'zvg-portal',
    country: 'de',
    externalId: '7265',
    ...overrides,
  } as never
}

async function loadHandler() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  return (await import('./reprocess-retry.post')).default as unknown as (event: unknown) => Promise<unknown>
}

function event(platform: string, id: string) {
  return { context: { params: { platform, id } } } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/auction/[platform]/[id]/reprocess-retry', () => {
  it('rejects an unsafe platform/id segment', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? '../etc' : '1'))
    const handler = await loadHandler()

    await expect(handler(event('../etc', '1'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the auction is unknown', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue(null)
    const handler = await loadHandler()

    await expect(handler(event('zvg-portal', '7265'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('force-triggers a scoped reprocess for exactly this auction', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    const runTask = vi.fn().mockResolvedValue({ result: {} })
    vi.stubGlobal('runTask', runTask)
    const handler = await loadHandler()

    await expect(handler(event('zvg-portal', '7265'))).resolves.toEqual({ started: true })
    expect(runTask).toHaveBeenCalledWith('reprocess', {
      payload: { platform: 'zvg-portal', externalId: '7265', force: true },
    })
  })

  it('does not let a rejected task run reject the request', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'zvg-portal' : '7265'))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.stubGlobal('runTask', vi.fn().mockRejectedValue(new Error('boom')))
    const handler = await loadHandler()

    await expect(handler(event('zvg-portal', '7265'))).resolves.toEqual({ started: true })
  })
})
