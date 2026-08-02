import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { getPool } from './db'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const {
  applyAuctionFetchState,
  writeAuctionCrawlFetchState,
  writeAuctionLlmPipelineState,
  writeAuctionPhotoPipelineState,
} = await import('./auction-fetch-state')

function auction(): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Berlin',
    externalId: '1',
    caseNumber: '1 K 1/26',
    authority: 'Berlin',
    title: 'Test',
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: '/pdf',
    pdfUrlUpstream: 'https://example.test/pdf',
    detailUrl: '/detail',
    detailUrlUpstream: 'https://example.test/detail',
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

afterEach(() => vi.clearAllMocks())

describe('auction fetch state writers', () => {
  it('keeps crawl, photo and LLM writes column-scoped', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await writeAuctionCrawlFetchState([auction()])
    await writeAuctionPhotoPipelineState('test', '1', {
      photosCheckedAt: '2026-08-02T10:00:00.000Z',
      photoFailures: 2,
      photoPipelineVersion: 3,
    })
    await writeAuctionLlmPipelineState('test', '1', { llmBatchJob: 'batch-1', llmFailures: 1 })
    const calls = query.mock.calls as unknown as Array<[string, unknown[]?]>

    const crawlSql = String(calls[0]?.[0])
    expect(crawlSql).not.toContain('llm_batch_job =')
    expect(crawlSql).not.toContain('photo_failures = EXCLUDED')

    const photoSql = String(calls[1]?.[0])
    expect(photoSql).toContain('photo_failures = EXCLUDED.photo_failures')
    expect(photoSql).not.toContain('llm_batch_job = EXCLUDED')
    expect(photoSql).not.toContain('attachments = EXCLUDED')

    const llmSql = String(calls[2]?.[0])
    expect(llmSql).toContain('llm_batch_job = EXCLUDED.llm_batch_job')
    expect(llmSql).not.toContain('photo_failures = EXCLUDED')
    expect(llmSql).not.toContain('attachments = EXCLUDED')
  })

  it('applies mutable state without replacing immutable extraction facts', () => {
    const value = auction()
    value.extraction = {
      propertyType: 'eigentumswohnung',
      landAreaSqm: null,
      livingAreaSqm: 70,
      rooms: 3,
      units: 1,
      source: 'llm',
      confidence: 'high',
      at: '2026-08-02T10:00:00.000Z',
    }

    applyAuctionFetchState(value, {
      platform: 'test',
      externalId: '1',
      pdfUrl: '/new.pdf',
      pdfUrlUpstream: null,
      detailUrl: null,
      detailUrlUpstream: null,
      attachments: [],
      photoUrls: ['https://example.test/photo.jpg'],
      sourceUpdatedIso: null,
      detailFetchedAt: '2026-08-02T10:00:00.000Z',
      llmBatchJob: 'batch-1',
      llmFailures: 2,
      photosCheckedAt: '2026-08-02T11:00:00.000Z',
      photoFailures: 1,
      photoPipelineVersion: 3,
      updatedAt: '2026-08-02T11:00:00.000Z',
    })

    expect(value.pdfUrl).toBe('/new.pdf')
    expect(value.extraction).toMatchObject({
      propertyType: 'eigentumswohnung',
      livingAreaSqm: 70,
      llmBatchJob: 'batch-1',
      llmFailures: 2,
      photoFailures: 1,
      photoPipelineVersion: 3,
    })
  })
})
