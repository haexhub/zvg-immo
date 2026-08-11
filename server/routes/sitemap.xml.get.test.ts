import { afterEach, describe, expect, it, vi } from 'vitest'

const { canonicalAppOrigin, readPublicAuctions } = vi.hoisted(() => ({
  canonicalAppOrigin: vi.fn(),
  readPublicAuctions: vi.fn(),
}))
vi.mock('../utils/outbound-delivery', () => ({ canonicalAppOrigin }))
vi.mock('../utils/data-api-auction', () => ({ readPublicAuctions }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/sitemap.xml', () => {
  it('lists the static pages plus every current auction from the public reader', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const setHeader = vi.fn()
    vi.stubGlobal('setHeader', setHeader)
    canonicalAppOrigin.mockReturnValue('https://zvg.example.test')
    readPublicAuctions.mockResolvedValueOnce({
      data: [{ appUrl: '/objekt/zvg-portal/7265', lastUpdated: '2026-08-01T10:00:00.000Z' }],
      total: 1,
    })
    const handler = (await import('./sitemap.xml.get')).default as unknown as (event: unknown) => Promise<string>

    const body = await handler({})

    expect(setHeader).toHaveBeenCalledWith({}, 'content-type', 'application/xml; charset=utf-8')
    expect(body).toContain('<loc>https://zvg.example.test/</loc>')
    expect(body).toContain('<loc>https://zvg.example.test/search</loc>')
    expect(body).toContain('<loc>https://zvg.example.test/objekt/zvg-portal/7265</loc>')
    expect(body).toContain('<lastmod>2026-08-01</lastmod>')
    expect(readPublicAuctions).toHaveBeenCalledWith({ includeWithdrawn: false, page: 1, pageSize: 1000 })
  })

  it('stops once every page has been read instead of looping forever', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('setHeader', vi.fn())
    canonicalAppOrigin.mockReturnValue('https://zvg.example.test')
    readPublicAuctions.mockResolvedValue({ data: [], total: 0 })
    const handler = (await import('./sitemap.xml.get')).default as unknown as (event: unknown) => Promise<string>

    await handler({})

    expect(readPublicAuctions).toHaveBeenCalledTimes(1)
  })
})
