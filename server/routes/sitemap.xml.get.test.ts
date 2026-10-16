import { afterEach, describe, expect, it, vi } from 'vitest'

const { canonicalAppOrigin, readPublicAuctionLinks } = vi.hoisted(() => ({
  canonicalAppOrigin: vi.fn(),
  readPublicAuctionLinks: vi.fn(),
}))
vi.mock('../utils/outbound-delivery', () => ({ canonicalAppOrigin }))
vi.mock('../utils/data-api-auction', () => ({ readPublicAuctionLinks }))

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
    readPublicAuctionLinks.mockResolvedValueOnce([
      { appUrl: '/objekt/zvg-portal/7265', lastUpdated: '2026-08-01T10:00:00.000Z' },
    ])
    const handler = (await import('./sitemap.xml.get')).default as unknown as (event: unknown) => Promise<string>

    const body = await handler({})

    expect(setHeader).toHaveBeenCalledWith({}, 'content-type', 'application/xml; charset=utf-8')
    expect(body).toContain('<loc>https://zvg.example.test/</loc>')
    expect(body).toContain('<loc>https://zvg.example.test/search</loc>')
    expect(body).toContain('<loc>https://zvg.example.test/objekt/zvg-portal/7265</loc>')
    expect(body).toContain('<lastmod>2026-08-01</lastmod>')
    // One bounded read, leaving room for the two static entries under the
    // 50,000-URL sitemap cap.
    expect(readPublicAuctionLinks).toHaveBeenCalledOnce()
    expect(readPublicAuctionLinks).toHaveBeenCalledWith(49_998)
  })
})
