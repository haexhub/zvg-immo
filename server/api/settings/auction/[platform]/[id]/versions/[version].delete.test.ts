import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-details', () => ({ deleteAuctionDetailsVersion: vi.fn() }))

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

describe('DELETE /api/settings/auction/[platform]/[id]/versions/[version]', () => {
  it('rejects a non-numeric version', async () => {
    stubParams('abc')

    const handler = (await import('./[version].delete')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the version does not exist', async () => {
    stubParams('2')
    const { deleteAuctionDetailsVersion } = await import('~/server/utils/auction-details')
    vi.mocked(deleteAuctionDetailsVersion).mockResolvedValue('not_found')

    const handler = (await import('./[version].delete')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('409s when the version is the live one', async () => {
    stubParams('1')
    const { deleteAuctionDetailsVersion } = await import('~/server/utils/auction-details')
    vi.mocked(deleteAuctionDetailsVersion).mockResolvedValue('is_latest')

    const handler = (await import('./[version].delete')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 409 })
  })

  it('deletes a non-live version', async () => {
    stubParams('2')
    const { deleteAuctionDetailsVersion } = await import('~/server/utils/auction-details')
    vi.mocked(deleteAuctionDetailsVersion).mockResolvedValue('deleted')

    const handler = (await import('./[version].delete')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ deleted: true })
    expect(deleteAuctionDetailsVersion).toHaveBeenCalledWith('zvg-portal', '7265', 2)
  })
})
