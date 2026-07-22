import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from '../utils/db'
import { downloadBlob, findLatestCapture } from '../utils/storage-download'
import { extractByLlm } from '../utils/extract/llm'
import { readExtractionCache, writeExtractionCache } from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'

vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../utils/storage-download', () => ({ findLatestCapture: vi.fn(), downloadBlob: vi.fn() }))
vi.mock('../utils/extract/llm', () => ({ extractByLlm: vi.fn() }))
vi.mock('../utils/extraction-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extraction-cache')>()
  return { ...actual, readExtractionCache: vi.fn(), writeExtractionCache: vi.fn() }
})
vi.mock('../utils/auction-snapshot', () => ({ readAuctionSnapshot: vi.fn(), writeAuctionSnapshot: vi.fn() }))
// defineTask is a Nitro auto-import, not present in the plain vitest
// environment — stub it so importing the module (which calls it at the top
// level for the default export) doesn't throw. Only reprocessAuction/
// runReprocess are under test here, not the task wrapper itself.
vi.stubGlobal('defineTask', (def: unknown) => def)

const { reprocessAuction, runReprocess } = await import('./reprocess')

// Minimal one-page PDF with a vector rectangle, no text at all (poppler
// recovers these via brute-force xref scanning) — pdftotext yields empty
// output on it, so it stands in for a scanned/image-only Gutachten and
// naturally exercises the vision fallback. Same fixture as
// server/utils/extract/pdf-render.test.ts.
const SCANNED_LIKE_PDF = Buffer.from(
  [
    '%PDF-1.1',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>/Contents 4 0 R>>endobj',
    '4 0 obj<</Length 41>>stream',
    '1 0 0 RG 10 10 180 180 re S',
    'endstream',
    'endobj',
    'trailer<</Root 1 0 R/Size 5>>',
    '%%EOF',
    '',
  ].join('\n'),
)

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Sachsen',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Musterstadt',
    title: null,
    address: 'Musterstraße 1, 01234 Musterstadt',
    marketValueEur: 100_000,
    marketValueText: '100.000 EUR',
    auctionDateIso: '2026-08-01T09:00:00.000Z',
    auctionDateText: '01.08.2026',
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
    ...overrides,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('reprocessAuction', () => {
  it('returns null when no auction capture is archived', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue(null)
    expect(await reprocessAuction('zvg-portal', '7265', undefined, null, '2026-07-22T00:00:00.000Z')).toBeNull()
  })

  it('returns null when the auction capture bytes cannot be read', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue({ contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' })
    vi.mocked(downloadBlob).mockResolvedValue(null)
    expect(await reprocessAuction('zvg-portal', '7265', undefined, null, '2026-07-22T00:00:00.000Z')).toBeNull()
  })

  it('resolves confidently from rules alone and never touches the LLM or document capture', async () => {
    const auction = makeAuction({
      title: 'Einfamilienhaus',
      description: 'Einfamilienhaus mit Wohnfläche ca. 140 m² und Grundstücksfläche 850 m².',
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))

    const result = await reprocessAuction('zvg-portal', '7265', undefined, null, '2026-07-22T00:00:00.000Z')

    expect(result).not.toBeNull()
    expect(result!.llmCalled).toBe(false)
    expect(result!.entry.source).toBe('rules')
    expect(result!.entry.propertyType).toBe('einfamilienhaus')
    expect(result!.entry.livingAreaSqm).toBe(140)
    expect(result!.entry.confidence).toBe('high')
    expect(extractByLlm).not.toHaveBeenCalled()
    // Only the 'auction' capture was looked up — no 'document' lookup when
    // the LLM branch never runs.
    expect(vi.mocked(findLatestCapture)).toHaveBeenCalledTimes(1)
  })

  it('falls back to the vision path for a scanned appraisal PDF and merges the LLM result', async () => {
    const auction = makeAuction({
      attachments: [
        { kind: 'appraisal', label: 'Gutachten', filename: 'gutachten.pdf', sizeBytes: 1000, fileId: '1', proxyUrl: '/api/zvg-proxy?file_id=1' },
      ],
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind) => {
      if (kind === 'auction') return { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' }
      if (kind === 'document') return { contentHash: 'doc1', sourceUrl: '/api/zvg-proxy?file_id=1', capturedAt: '2026-07-01T00:00:00.000Z' }
      return null
    })
    vi.mocked(downloadBlob).mockImplementation(async (hash) => {
      if (hash === 'abc') return Buffer.from(JSON.stringify(auction))
      if (hash === 'doc1') return SCANNED_LIKE_PDF
      return null
    })
    const llmResult = {
      propertyType: 'einfamilienhaus' as const,
      landAreaSqm: 850,
      livingAreaSqm: 140,
      rooms: 5,
      units: 1,
      securityDeposit: null,
      biddingNotes: null,
      condition: 'gepflegt' as const,
      features: ['garage' as const],
    }
    vi.mocked(extractByLlm).mockResolvedValue(llmResult)

    const result = await reprocessAuction('zvg-portal', '7265', undefined, { baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }, '2026-07-22T00:00:00.000Z')

    expect(result!.llmCalled).toBe(true)
    expect(result!.entry.source).toBe('llm')
    expect(result!.entry.propertyType).toBe('einfamilienhaus')
    expect(result!.entry.condition).toBe('gepflegt')
    expect(result!.entry.features).toEqual(['garage'])

    const callArgs = vi.mocked(extractByLlm).mock.calls[0]![0]
    expect(callArgs.pdfImageBase64).not.toBeNull()
    expect(Buffer.from(callArgs.pdfImageBase64!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('bumps llmFailures and keeps the prior rules-only fields when the LLM request fails', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(extractByLlm).mockResolvedValue(null)

    const prior: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      llmFailures: 1,
      at: '2026-07-01T00:00:00.000Z',
    }
    const result = await reprocessAuction('zvg-portal', '7265', prior, { baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }, '2026-07-22T00:00:00.000Z')

    expect(result!.entry.source).toBe('rules')
    expect(result!.entry.llmFailures).toBe(2)
  })

  it('skips the LLM branch entirely when llmConfig is null', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))

    const result = await reprocessAuction('zvg-portal', '7265', undefined, null, '2026-07-22T00:00:00.000Z')

    expect(result!.llmCalled).toBe(false)
    expect(extractByLlm).not.toHaveBeenCalled()
  })
})

describe('runReprocess', () => {
  beforeEach(() => {
    vi.mocked(readExtractionCache).mockResolvedValue({})
    vi.mocked(readAuctionSnapshot).mockResolvedValue({})
    vi.mocked(writeExtractionCache).mockResolvedValue(true)
    vi.mocked(writeAuctionSnapshot).mockResolvedValue(undefined)
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: {} }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a forced run with no filter', async () => {
    await expect(runReprocess({ force: true })).rejects.toThrow(/requires platform/)
  })

  it('returns all-zero without a configured DB pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    const result = await runReprocess({})
    expect(result).toEqual({ candidates: 0, processed: 0, skipped: 0, llmCalls: 0 })
  })

  it('scopes the candidate query to country=de plus any given filters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await runReprocess({ platform: 'zvg-portal', externalId: '7265' })

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("kind = 'auction'")
    expect(sql).toContain('country = $1')
    expect(sql).toContain('platform = $2')
    expect(sql).toContain('external_id = $3')
    expect(params).toEqual(['de', 'zvg-portal', '7265'])
  })

  it('skips already-complete entries by default and processes them when forced', async () => {
    const auction = makeAuction({
      title: 'Einfamilienhaus',
      description: 'Einfamilienhaus mit Wohnfläche ca. 140 m² und Grundstücksfläche 850 m².',
    })
    const query = vi.fn().mockResolvedValue({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))

    const completeEntry: AuctionExtraction = {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 850,
      livingAreaSqm: 140,
      rooms: 5,
      units: 1,
      condition: 'gepflegt',
      features: [],
      source: 'llm',
      confidence: 'high',
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': completeEntry })

    const skippedResult = await runReprocess({})
    expect(skippedResult).toEqual({ candidates: 1, processed: 0, skipped: 1, llmCalls: 0 })
    expect(writeExtractionCache).not.toHaveBeenCalled()

    const forcedResult = await runReprocess({ platform: 'zvg-portal', force: true })
    expect(forcedResult.processed).toBe(1)
    expect(writeExtractionCache).toHaveBeenCalledWith({ 'zvg-portal:7265': expect.objectContaining({ propertyType: 'einfamilienhaus' }) })
  })

  it('syncs auction_snapshot only for auctions present in the snapshot', async () => {
    const auction = makeAuction({
      title: 'Einfamilienhaus',
      description: 'Einfamilienhaus mit Wohnfläche ca. 140 m² und Grundstücksfläche 850 m².',
    })
    const query = vi.fn().mockResolvedValue({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(readAuctionSnapshot).mockResolvedValue({ 'zvg-portal:7265': auction })

    await runReprocess({})

    expect(writeAuctionSnapshot).toHaveBeenCalledTimes(1)
    const [written] = vi.mocked(writeAuctionSnapshot).mock.calls[0]!
    expect(written[0]!.extraction).toMatchObject({ propertyType: 'einfamilienhaus' })
  })

  it('caps LLM calls per run and still caches a rules-only result for candidates beyond the cap', async () => {
    const auctionA = makeAuction({ externalId: '1' })
    const auctionB = makeAuction({ externalId: '2' })
    const query = vi.fn().mockResolvedValue({
      rows: [
        { platform: 'zvg-portal', external_id: '1' },
        { platform: 'zvg-portal', external_id: '2' },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind, _platform, externalId) => {
      if (kind !== 'auction') return null
      return { contentHash: externalId, sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' }
    })
    vi.mocked(downloadBlob).mockImplementation(async (hash) =>
      hash === '1' ? Buffer.from(JSON.stringify(auctionA)) : Buffer.from(JSON.stringify(auctionB)),
    )
    vi.mocked(extractByLlm).mockResolvedValue({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: null,
      features: [],
    })
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy', maxPerRun: '1' } }))

    const result = await runReprocess({})

    expect(result.processed).toBe(2)
    expect(result.llmCalls).toBe(1)
    expect(extractByLlm).toHaveBeenCalledTimes(1)
  })
})
