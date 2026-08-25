import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'

vi.mock('../../utils/auction-record', () => ({ readAuctionRecord: vi.fn() }))
vi.mock('../../crawlers/dga-ag/detail', () => ({ fetchFreshObjectDocumentUrl: vi.fn() }))

function stubHandlerGlobals() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) =>
    Object.assign(new Error(input.statusMessage), input),
  )
  vi.stubGlobal('sendRedirect', vi.fn((_event: unknown, url: string, code: number) => ({ url, code })))
}

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'dga-ag',
    country: 'de',
    region: 'Sachsen',
    externalId: 'S26-03-117',
    caseNumber: '',
    authority: 'SGA AG',
    title: null,
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://www.dga-ag.de/objekt/S26-03-117.html',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://www.dga-ag.de/objekt/S26-03-117.html',
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('GET /api/dga-ag-document/:externalId', () => {
  it('rejects an unsafe externalId', async () => {
    stubHandlerGlobals()
    const handler = (await import('./[externalId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { externalId: '../etc' } } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the auction is not on record', async () => {
    stubHandlerGlobals()
    const { readAuctionRecord } = await import('../../utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue(null)
    const handler = (await import('./[externalId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { externalId: 'S26-03-117' } } })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('404s when the live detail page has no Objektunterlagen link', async () => {
    stubHandlerGlobals()
    const { readAuctionRecord } = await import('../../utils/auction-record')
    const { fetchFreshObjectDocumentUrl } = await import('../../crawlers/dga-ag/detail')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(fetchFreshObjectDocumentUrl).mockResolvedValue(null)
    const handler = (await import('./[externalId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { externalId: 'S26-03-117' } } })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('redirects to the freshly-fetched Objektunterlagen href', async () => {
    stubHandlerGlobals()
    const { readAuctionRecord } = await import('../../utils/auction-record')
    const { fetchFreshObjectDocumentUrl } = await import('../../crawlers/dga-ag/detail')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(fetchFreshObjectDocumentUrl).mockResolvedValue('https://www.dga-ag.de/securedl/sdl-fresh/S26_03_117.pdf')
    const handler = (await import('./[externalId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { externalId: 'S26-03-117' } } })).resolves.toEqual({
      url: 'https://www.dga-ag.de/securedl/sdl-fresh/S26_03_117.pdf',
      code: 302,
    })
    expect(fetchFreshObjectDocumentUrl).toHaveBeenCalledWith('https://www.dga-ag.de/objekt/S26-03-117.html')
  })
})
