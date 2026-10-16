import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-details', () => ({ promoteAuctionDetailsVersion: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

function stubParams(version: string) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => ({ platform: 'zvg-portal', id: '7265', version })[name])
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
}

describe('POST /api/settings/auction/[platform]/[id]/versions/[version]/promote', () => {
  it('rejects a non-numeric version', async () => {
    stubParams('abc')

    const handler = (await import('./promote.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the version does not exist', async () => {
    stubParams('2')
    const { promoteAuctionDetailsVersion } = await import('~/server/utils/auction-details')
    vi.mocked(promoteAuctionDetailsVersion).mockResolvedValue('not_found')

    const handler = (await import('./promote.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('promotes a version', async () => {
    stubParams('2')
    const { promoteAuctionDetailsVersion } = await import('~/server/utils/auction-details')
    vi.mocked(promoteAuctionDetailsVersion).mockResolvedValue('promoted')

    const handler = (await import('./promote.post')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ promoted: true })
    expect(promoteAuctionDetailsVersion).toHaveBeenCalledWith('zvg-portal', '7265', 2)
  })
})
