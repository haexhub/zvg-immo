import { afterEach, describe, expect, it, vi } from 'vitest'

const { canonicalAppOrigin } = vi.hoisted(() => ({ canonicalAppOrigin: vi.fn() }))
vi.mock('../utils/outbound-delivery', () => ({ canonicalAppOrigin }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/robots.txt', () => {
  it('disallows private/utility routes and the JSON API but allows auction images, and points at the sitemap', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const setHeader = vi.fn()
    vi.stubGlobal('setHeader', setHeader)
    canonicalAppOrigin.mockReturnValue('https://zvg.example.test')
    const handler = (await import('./robots.txt.get')).default as unknown as (event: unknown) => string

    const body = handler({})

    expect(setHeader).toHaveBeenCalledWith({}, 'content-type', 'text/plain; charset=utf-8')
    expect(body).toContain('Disallow: /admin')
    expect(body).toContain('Disallow: /settings')
    expect(body).toContain('Disallow: /api/')
    expect(body).toContain('Allow: /api/auction-image/')
    expect(body).toContain('Sitemap: https://zvg.example.test/sitemap.xml')
  })
})
