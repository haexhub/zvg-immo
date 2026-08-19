import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import type { ParseResult } from './list'

const boeFetch = vi.fn()
const looksLikeCaptcha = vi.fn(() => false)
const markBoeCaptcha = vi.fn()
vi.mock('./fetch', () => ({ boeFetch, looksLikeCaptcha, markBoeCaptcha }))

const buildSearchUrl = vi.fn((provincia: string) => `search:${provincia}`)
const buildPageUrl = vi.fn((token: string, start: number) => `page:${token}:${start}`)
const extractBusquedaToken = vi.fn()
const parseListingHtml = vi.fn()
vi.mock('./list', () => ({ buildSearchUrl, buildPageUrl, extractBusquedaToken, parseListingHtml, PAGE_HITS: 500 }))

const enrichInBatches = vi.fn(async (auctions: Auction[]) => ({ enriched: auctions.length, errors: 0 }))
vi.mock('./detail', () => ({ enrichInBatches }))

function auction(externalId: string): Auction {
  return {
    platform: 'boe',
    country: 'es',
    region: 'Madrid',
    externalId,
    caseNumber: `SUB-JA-2026-${externalId}`,
    authority: 'AEAT',
    title: null,
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

function parseResult(auctions: Auction[], totalReported: number | null): ParseResult {
  return { totalReported, auctions }
}

beforeEach(() => {
  boeFetch.mockReset().mockResolvedValue('<html></html>')
  looksLikeCaptcha.mockReset().mockReturnValue(false)
  parseListingHtml.mockReset()
  extractBusquedaToken.mockReset()
  enrichInBatches.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('boe crawl', () => {
  it('reports success when the first page already covers the reported total', async () => {
    const { boeCrawler } = await import('./index')
    parseListingHtml.mockReturnValue(parseResult([auction('1'), auction('2')], 2))

    const result = await boeCrawler.crawl({ region: '28', enrichDetails: false })

    expect(result.platformsSucceeded).toEqual(['boe'])
  })

  it('does not report success when pagination stops early with no token found', async () => {
    const { boeCrawler } = await import('./index')
    parseListingHtml.mockReturnValue(parseResult([auction('1')], 50))
    extractBusquedaToken.mockReturnValue(null)

    const result = await boeCrawler.crawl({ region: '28', enrichDetails: false })

    expect(result.auctions).toHaveLength(1)
    expect(result.platformsSucceeded).toEqual([])
  })

  it('does not report success when a mid-pagination fetch fails', async () => {
    const { boeCrawler } = await import('./index')
    parseListingHtml.mockReturnValueOnce(parseResult([auction('1')], 50))
    extractBusquedaToken.mockReturnValue('token123')
    boeFetch.mockResolvedValueOnce('<html></html>').mockRejectedValueOnce(new Error('BOE 503'))

    const result = await boeCrawler.crawl({ region: '28', enrichDetails: false })

    expect(result.auctions).toHaveLength(1)
    expect(result.platformsSucceeded).toEqual([])
  })

  it('reports success once pagination collects every reported result', async () => {
    const { boeCrawler } = await import('./index')
    // PAGE_HITS is 500 — totalReported must exceed it for the pagination loop
    // to run at all (start=PAGE_HITS < totalReported).
    const firstPage = Array.from({ length: 500 }, (_, i) => auction(String(i + 1)))
    parseListingHtml
      .mockReturnValueOnce(parseResult(firstPage, 501))
      .mockReturnValueOnce(parseResult([auction('501')], 501))
    extractBusquedaToken.mockReturnValue('token123')

    const result = await boeCrawler.crawl({ region: '28', enrichDetails: false })

    expect(result.auctions).toHaveLength(501)
    expect(result.platformsSucceeded).toEqual(['boe'])
  })
})
