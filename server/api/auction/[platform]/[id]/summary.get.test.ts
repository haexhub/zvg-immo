import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/auction/[platform]/[id]/summary', () => {
  it('looks up one auction by exact platform/externalId and returns the AuctionSummary shape', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))

    const row = {
      platform: 'zvg-portal',
      country: 'de',
      region: 'Bayern',
      external_id: '42',
      case_number: '1 K 1/26',
      authority: 'AG München',
      title: 'Einfamilienhaus',
      address: 'Musterstraße 1',
      market_value: '450000',
      currency: 'EUR',
      market_value_eur: '450000',
      market_value_text: '450.000 EUR',
      starting_bid: null,
      current_bid: null,
      auction_date_iso: '2026-08-01T09:00:00.000Z',
      auction_date_text: '01.08.2026, 09:00',
      pdf_url: 'https://example.test/bekanntmachung.pdf',
      cancelled: false,
      photo_count: 1,
      thumbnail_url: null,
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        yearBuilt: 1990,
        lastRenovationYear: 2020,
        condition: 'gut',
        features: ['garage'],
        photos: [{ file: 'first.jpg', category: 'aussen', caption: null, isPropertyPhoto: true }],
        source: 'llm',
        llmAnalyzedAt: '2026-07-01T00:00:00.000Z',
      },
    }
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain('WHERE a.platform = $1 AND a.external_id = $2')
      expect(params).toEqual(['zvg-portal', '42'])
      return { rows: [row], rowCount: 1 }
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./summary.get')).default as unknown as (event: unknown) => Promise<unknown>

    const result = await handler({ context: { params: { platform: 'zvg-portal', id: '42' } } })
    expect(result).toMatchObject({
      platform: 'zvg-portal',
      externalId: '42',
      address: 'Musterstraße 1',
      pdfUrl: 'https://example.test/bekanntmachung.pdf',
    })
    expect((result as { galleryUrls: string[] }).galleryUrls).toEqual(['/api/auction-image/zvg-portal/42/first.jpg'])
  })

  it('404s when no auction matches', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./summary.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(
      handler({ context: { params: { platform: 'zvg-portal', id: 'missing' } } }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects an unsafe path segment', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const handler = (await import('./summary.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(
      handler({ context: { params: { platform: '../etc', id: '42' } } }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
