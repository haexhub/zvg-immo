import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from '../utils/db'
import { downloadBlob, findLatestCapture, readDocumentSetItems } from '../utils/storage-download'
import { extractByLlm } from '../utils/extract/llm'
import { isLlmBatchProviderBroken, submitLlmBatch } from '../utils/extract/llm-batch'
import { extractPdfTextFromBuffer } from '../utils/extract/pdf-text'
import { renderPdfPagesJpeg } from '../utils/extract/pdf-render'
import { readExtractionCache, writeExtractionCache } from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { ensureEnabledCountriesLoaded, getEnabledCountryCodes, isCountryEnabled } from '../crawlers/registry'
import { readFile } from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['se']),
  getEnabledCountryCodes: vi.fn(() => ['se']),
  isCountryEnabled: vi.fn((country: string) => country === 'se'),
}))
vi.mock('../utils/storage-download', () => ({
  findLatestCapture: vi.fn(),
  downloadBlob: vi.fn(),
  readDocumentSetItems: vi.fn(async () => []),
}))
vi.mock('../utils/extract/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extract/llm')>()
  return { ...actual, extractByLlm: vi.fn() }
})
vi.mock('../utils/extract/llm-batch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extract/llm-batch')>()
  return { ...actual, isLlmBatchProviderBroken: vi.fn(async () => false), submitLlmBatch: vi.fn() }
})
// Spy on (not stub out) the real implementations — other tests here rely on
// actual pdftotext/rendering output (e.g. the scanned-PDF vision-fallback
// test below); the gemini-native test only needs to assert these were never
// invoked, not replace their behavior.
vi.mock('../utils/extract/pdf-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extract/pdf-text')>()
  return { ...actual, extractPdfTextFromBuffer: vi.fn(actual.extractPdfTextFromBuffer) }
})
vi.mock('../utils/extract/pdf-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extract/pdf-render')>()
  return { ...actual, renderPdfPagesJpeg: vi.fn(actual.renderPdfPagesJpeg) }
})
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

function documentSetItem(overrides: {
  ordinal: number
  label: string
  filename: string
  fileId: string
  sourceUrl: string
  contentHash: string
  contentType?: 'application/pdf' | 'text/html' | 'image/jpeg'
}) {
  return {
    kind: 'document' as const,
    contentType: overrides.contentType ?? 'application/pdf',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(readDocumentSetItems).mockResolvedValue([])
})

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

  it('calls the LLM even when rules and the prior entry are already confident, merging yearBuilt/insights without touching rules-derived fields (rules as merge, not gate)', async () => {
    const auction = makeAuction({
      title: 'Einfamilienhaus',
      description: 'Einfamilienhaus mit Wohnfläche ca. 140 m² und Grundstücksfläche 850 m².',
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    const priorEntry: AuctionExtraction = {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 850,
      livingAreaSqm: 140,
      rooms: 5,
      bedrooms: 3,
      bathrooms: 2,
      floor: 'EG',
      bathroomHasTub: true,
      bathroomHasShower: true,
      heating: 'Gaszentralheizung',
      units: 1,
      condition: 'gepflegt',
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      insights: null,
      source: 'rules',
      confidence: 'high',
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(extractByLlm).mockResolvedValue({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: 4,
      bathrooms: 1.5,
      floor: '1. OG',
      bathroomHasTub: false,
      bathroomHasShower: true,
      heating: 'Wärmepumpe',
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: 'gepflegt',
      features: [],
      yearBuilt: 1998,
      lastRenovationYear: 2015,
      renovationNotes: 'Dach erneuert',
      insights: {
        defects: [],
        encumbrances: [],
        landValueEurPerSqm: null,
        construction: null,
        locationCharacter: null,
        summary: 'Solide Bausubstanz.',
      },
      planningNotes: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })

    const result = await reprocessAuction(
      'zvg-portal',
      '7265',
      priorEntry,
      { baseUrl: 'http://proxy', model: 'claude-haiku-4-5' },
      '2026-07-22T00:00:00.000Z',
    )

    expect(extractByLlm).toHaveBeenCalledTimes(1)
    expect(result!.entry.source).toBe('rules')
    expect(result!.entry.propertyType).toBe('einfamilienhaus')
    expect(result!.entry.livingAreaSqm).toBe(140)
    expect(result!.entry.bedrooms).toBe(4)
    expect(result!.entry.bathrooms).toBe(1.5)
    expect(result!.entry.floor).toBe('1. OG')
    expect(result!.entry.bathroomHasTub).toBe(false)
    expect(result!.entry.bathroomHasShower).toBe(true)
    expect(result!.entry.heating).toBe('Wärmepumpe')
    expect(result!.entry.yearBuilt).toBe(1998)
    expect(result!.entry.lastRenovationYear).toBe(2015)
    expect(result!.entry.renovationNotes).toBe('Dach erneuert')
    expect(result!.entry.insights?.summary).toBe('Solide Bausubstanz.')
  })

  it('falls back to the vision path for a scanned appraisal PDF and merges the LLM result', async () => {
    const auction = makeAuction({
      attachments: [
        { kind: 'appraisal', label: 'Gutachten', filename: 'gutachten.pdf', sizeBytes: 1000, fileId: '1', proxyUrl: '/api/zvg-proxy?file_id=1' },
      ],
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind) => {
      if (kind === 'auction') return { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' }
      return null
    })
    vi.mocked(readDocumentSetItems).mockResolvedValue([
      documentSetItem({
        ordinal: 0,
        label: 'Gutachten',
        filename: 'gutachten.pdf',
        fileId: '1',
        sourceUrl: '/api/zvg-proxy?file_id=1',
        contentHash: 'doc1',
      }),
    ])
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
      bedrooms: 2,
      bathrooms: 1,
      floor: 'DG',
      bathroomHasTub: true,
      bathroomHasShower: false,
      heating: 'Fernwärme',
      units: 1,
      securityDeposit: null,
      biddingNotes: null,
      condition: 'gepflegt' as const,
      features: ['garage' as const],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    }
    vi.mocked(extractByLlm).mockResolvedValue(llmResult)

    const result = await reprocessAuction('zvg-portal', '7265', undefined, { baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }, '2026-07-22T00:00:00.000Z')

    expect(result!.llmCalled).toBe(true)
    expect(result!.entry.source).toBe('llm')
    expect(result!.entry.propertyType).toBe('einfamilienhaus')
    expect(result!.entry.condition).toBe('gepflegt')
    expect(result!.entry.features).toEqual(['garage'])

    const callArgs = vi.mocked(extractByLlm).mock.calls[0]![0]
    expect(callArgs.pdfPageImages).not.toBeNull()
    expect(callArgs.pdfPageImages).toHaveLength(1)
    expect(Buffer.from(callArgs.pdfPageImages![0]!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('feeds a gemini-native call the raw PDF bytes and skips pdftotext/vision rendering', async () => {
    const auction = makeAuction({
      attachments: [
        { kind: 'appraisal', label: 'Gutachten', filename: 'gutachten.pdf', sizeBytes: 1000, fileId: '1', proxyUrl: '/api/zvg-proxy?file_id=1' },
      ],
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind) => {
      if (kind === 'auction') return { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' }
      return null
    })
    vi.mocked(readDocumentSetItems).mockResolvedValue([
      documentSetItem({
        ordinal: 0,
        label: 'Gutachten',
        filename: 'gutachten.pdf',
        fileId: '1',
        sourceUrl: '/api/zvg-proxy?file_id=1',
        contentHash: 'doc1',
      }),
    ])
    vi.mocked(downloadBlob).mockImplementation(async (hash) => {
      if (hash === 'abc') return Buffer.from(JSON.stringify(auction))
      if (hash === 'doc1') return SCANNED_LIKE_PDF
      return null
    })
    vi.mocked(extractByLlm).mockResolvedValue({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: 2,
      bathrooms: 1,
      floor: 'DG',
      bathroomHasTub: true,
      bathroomHasShower: false,
      heating: 'Fernwärme',
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: null,
      features: [],
      yearBuilt: 1998,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })

    await reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      { provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' },
      '2026-07-22T00:00:00.000Z',
    )

    const callArgs = vi.mocked(extractByLlm).mock.calls[0]![0]
    expect(callArgs.pdfText).toBeNull()
    expect(callArgs.pdfPageImages).toBeNull()
    expect(callArgs.pdfBytes).toEqual(SCANNED_LIKE_PDF.toString('base64'))
    expect(extractPdfTextFromBuffer).not.toHaveBeenCalled()
    expect(renderPdfPagesJpeg).not.toHaveBeenCalled()
  })

  it('feeds every archived document format to native-document LLM providers', async () => {
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9])
    const auction = makeAuction({
      attachments: [
        { kind: 'appraisal', label: 'Gutachten', filename: 'gutachten.pdf', sizeBytes: 1000, fileId: '1', proxyUrl: '/api/zvg-proxy?file_id=1' },
        { kind: 'other', label: 'Biethinweise', filename: 'hinweise.pdf', sizeBytes: 500, fileId: '2', proxyUrl: '/api/zvg-proxy?file_id=2' },
        { kind: 'brochure', label: 'Expose HTML', filename: 'expose.html', sizeBytes: 400, fileId: '3', proxyUrl: 'https://example.test/expose.html' },
        { kind: 'other', label: 'Scan JPG', filename: 'scan.jpg', sizeBytes: jpgBytes.length, fileId: '4', proxyUrl: 'https://example.test/scan.jpg' },
      ],
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind, _platform, _externalId, sourceUrl) => {
      if (kind === 'auction') return { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' }
      if (kind === 'detail_html') return { contentHash: 'detail', sourceUrl: 'https://example.test/detail', capturedAt: '2026-07-01T00:00:00.000Z' }
      return null
    })
    vi.mocked(readDocumentSetItems).mockResolvedValue([
      documentSetItem({
        ordinal: 0,
        label: 'Gutachten',
        filename: 'gutachten.pdf',
        fileId: '1',
        sourceUrl: '/api/zvg-proxy?file_id=1',
        contentHash: 'doc1',
      }),
      documentSetItem({
        ordinal: 1,
        label: 'Expose HTML',
        filename: 'expose.html',
        fileId: '3',
        sourceUrl: 'https://example.test/expose.html',
        contentHash: 'doc3',
        contentType: 'text/html',
      }),
      documentSetItem({
        ordinal: 2,
        label: 'Scan JPG',
        filename: 'scan.jpg',
        fileId: '4',
        sourceUrl: 'https://example.test/scan.jpg',
        contentHash: 'doc4',
        contentType: 'image/jpeg',
      }),
      documentSetItem({
        ordinal: 3,
        label: 'Biethinweise',
        filename: 'hinweise.pdf',
        fileId: '2',
        sourceUrl: '/api/zvg-proxy?file_id=2',
        contentHash: 'doc2',
      }),
    ])
    vi.mocked(downloadBlob).mockImplementation(async (hash) => {
      if (hash === 'abc') return Buffer.from(JSON.stringify(auction))
      if (hash === 'doc1') return Buffer.from('%PDF-1.4\none\n%%EOF')
      if (hash === 'doc2') return Buffer.from('%PDF-1.4\ntwo\n%%EOF')
      if (hash === 'doc3') return Buffer.from('<html><body><h1>Wohnhaus</h1><p>Baujahr 1999</p></body></html>')
      if (hash === 'doc4') return jpgBytes
      if (hash === 'detail') return Buffer.from('<html><body><p>Detail HTML: Grundstueck 700 m2</p></body></html>')
      return null
    })
    vi.mocked(extractByLlm).mockResolvedValue({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: null,
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })

    await reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      { provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' },
      '2026-07-22T00:00:00.000Z',
    )

    const callArgs = vi.mocked(extractByLlm).mock.calls[0]![0]
    expect(callArgs.pdfBytes).toBeNull()
    expect(callArgs.pdfDocuments).toEqual([
      { label: 'Gutachten', data: Buffer.from('%PDF-1.4\none\n%%EOF').toString('base64') },
      { label: 'Biethinweise', data: Buffer.from('%PDF-1.4\ntwo\n%%EOF').toString('base64') },
    ])
    expect(callArgs.documentText).toContain('Wohnhaus')
    expect(callArgs.documentText).toContain('Detail HTML: Grundstueck 700 m2')
    expect(callArgs.documentImages).toEqual([
      { label: 'Scan JPG', mimeType: 'image/jpeg', data: jpgBytes.toString('base64') },
    ])
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
      bedrooms: 2,
      bathrooms: 1,
      floor: 'DG',
      bathroomHasTub: true,
      bathroomHasShower: false,
      heating: 'Fernwärme',
      units: null,
      source: 'rules',
      confidence: 'low',
      llmFailures: 1,
      at: '2026-07-01T00:00:00.000Z',
    }
    const result = await reprocessAuction('zvg-portal', '7265', prior, { baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }, '2026-07-22T00:00:00.000Z')

    expect(result!.entry.source).toBe('rules')
    expect(result!.entry.llmFailures).toBe(2)
    expect(result!.entry.bedrooms).toBe(2)
    expect(result!.entry.bathrooms).toBe(1)
    expect(result!.entry.floor).toBe('DG')
    expect(result!.entry.bathroomHasTub).toBe(true)
    expect(result!.entry.bathroomHasShower).toBe(false)
    expect(result!.entry.heating).toBe('Fernwärme')
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

  it('keeps prior LLM-only fields when llmConfig is null and only rules run', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    const priorEntry: AuctionExtraction = {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 850,
      livingAreaSqm: 140,
      rooms: 5,
      bedrooms: 3,
      bathrooms: 2,
      floor: 'EG',
      bathroomHasTub: true,
      bathroomHasShower: true,
      heating: 'Gaszentralheizung',
      units: 1,
      source: 'rules',
      confidence: 'low',
      at: '2026-07-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, null, '2026-07-22T00:00:00.000Z')

    expect(result!.llmCalled).toBe(false)
    expect(result!.entry).toMatchObject({
      bedrooms: 3,
      bathrooms: 2,
      floor: 'EG',
      bathroomHasTub: true,
      bathroomHasShower: true,
      heating: 'Gaszentralheizung',
    })
  })
})

describe('reprocessAuction: archivedDocumentSetHash vs documentSetHash', () => {
  const llmResult = {
    propertyType: null,
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    bathroomHasTub: null,
    bathroomHasShower: null,
    heating: null,
    units: null,
    securityDeposit: null,
    biddingNotes: null,
    condition: 'gepflegt' as const,
    features: ['garage' as const],
    yearBuilt: null,
    lastRenovationYear: null,
    renovationNotes: null,
    insights: null,
    planningNotes: null,
    photoCuration: [],
    marketValueEur: null,
    marketValueText: null,
  }

  it('rebuilds LLM-only fields from scratch instead of merging stale ones when the archived set changed', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(extractByLlm).mockResolvedValue(llmResult)
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))

    // documentSetHash (last parsed) is stale relative to archivedDocumentSetHash
    // (enrich.ts's latest archive) — a document changed since the last parse.
    const priorEntry: AuctionExtraction = {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 500,
      livingAreaSqm: 120,
      rooms: 4,
      units: 1,
      source: 'llm',
      confidence: 'high',
      condition: 'sanierungsbeduerftig',
      features: ['stellplatz'],
      insights: { summary: 'old insight' } as never,
      documentSetHash: 'old-hash',
      documentSetVersion: 1,
      archivedDocumentSetHash: 'new-hash',
      archivedDocumentSetVersion: 2,
      at: '2026-06-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, { baseUrl: 'http://proxy' } as never, '2026-07-22T00:00:00.000Z')

    // The stale condition/features/old insight must not survive — only the
    // fresh LLM result (or nothing) does.
    expect(result!.entry.condition).toBe('gepflegt')
    expect(result!.entry.features).toEqual(['garage'])
    expect(result!.entry.insights).toBeNull()
  })

  it('marks documentSetHash caught up to archivedDocumentSetHash after a successful parse', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(extractByLlm).mockResolvedValue(llmResult)
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))

    const priorEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      archivedDocumentSetHash: 'new-hash',
      archivedDocumentSetVersion: 2,
      at: '2026-06-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, { baseUrl: 'http://proxy' } as never, '2026-07-22T00:00:00.000Z')

    expect(result!.entry.documentSetHash).toBe('new-hash')
    expect(result!.entry.documentSetVersion).toBe(2)
    expect(result!.entry.archivedDocumentSetHash).toBe('new-hash')
    expect(result!.entry.archivedDocumentSetVersion).toBe(2)
  })

  it('carries archivedDocumentSetHash/Version through unchanged when the LLM is disabled (rules-only path)', async () => {
    const auction = makeAuction({
      title: 'Einfamilienhaus',
      description: 'Einfamilienhaus mit Wohnfläche ca. 140 m² und Grundstücksfläche 850 m².',
    })
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))

    const priorEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      archivedDocumentSetHash: 'a-hash',
      archivedDocumentSetVersion: 3,
      at: '2026-06-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, null, '2026-07-22T00:00:00.000Z')

    // No LLM attempt happened, so this task hasn't "caught up" — only the
    // crawl-owned archived* bookkeeping passes through untouched.
    expect(result!.entry.documentSetHash).toBeNull()
    expect(result!.entry.archivedDocumentSetHash).toBe('a-hash')
    expect(result!.entry.archivedDocumentSetVersion).toBe(3)
  })

  it('does not mark documentSetHash caught up when the LLM request fails', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(extractByLlm).mockResolvedValue(null)

    const priorEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      documentSetHash: 'old-hash',
      documentSetVersion: 1,
      archivedDocumentSetHash: 'new-hash',
      archivedDocumentSetVersion: 2,
      at: '2026-06-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, { baseUrl: 'http://proxy' } as never, '2026-07-22T00:00:00.000Z')

    // The failed request must not be stamped as "parsed" — otherwise the
    // listing would never become due for reprocessing again.
    expect(result!.entry.documentSetHash).toBe('old-hash')
    expect(result!.entry.documentSetVersion).toBe(1)
    expect(result!.entry.archivedDocumentSetHash).toBe('new-hash')
  })

  it('does not mark documentSetHash caught up when the archived document set could not be read in full', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(readDocumentSetItems).mockResolvedValueOnce(null)
    vi.mocked(extractByLlm).mockResolvedValue(llmResult)
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))

    const priorEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      documentSetHash: 'old-hash',
      documentSetVersion: 1,
      archivedDocumentSetHash: 'new-hash',
      archivedDocumentSetVersion: 2,
      at: '2026-06-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, { baseUrl: 'http://proxy' } as never, '2026-07-22T00:00:00.000Z')

    // The LLM call "succeeded" but only against a partially-read document
    // set (readDocumentSetItems returned null) — documentSetHash must not
    // jump to archivedDocumentSetHash, or the missing document(s) would
    // never be picked up on a later run.
    expect(result!.entry.documentSetHash).toBe('old-hash')
    expect(result!.entry.documentSetVersion).toBe(1)
    expect(result!.entry.archivedDocumentSetHash).toBe('new-hash')
  })
})

describe('reprocessAuction: candidate photo tolerance and curation remap', () => {
  const basePhotos = [
    { file: 'a.jpg', category: 'sonstiges' as const, caption: null, isPropertyPhoto: false },
    { file: 'b.jpg', category: 'sonstiges' as const, caption: null, isPropertyPhoto: false },
    { file: 'c.jpg', category: 'sonstiges' as const, caption: null, isPropertyPhoto: false },
  ]
  const llmResult = {
    propertyType: null,
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    bathroomHasTub: null,
    bathroomHasShower: null,
    heating: null,
    units: null,
    securityDeposit: null,
    biddingNotes: null,
    condition: null,
    features: [],
    yearBuilt: null,
    lastRenovationYear: null,
    renovationNotes: null,
    insights: null,
    planningNotes: null,
    photoCuration: [],
    marketValueEur: null,
    marketValueText: null,
  }

  it('drops an unreadable candidate photo instead of failing the whole batch, and remaps the LLM curation back onto the original photo positions', async () => {
    const auction = makeAuction()
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    // b.jpg (original index 1) fails to read — only a.jpg/c.jpg (original
    // indices 0/2) reach the LLM, as candidateImages[0]/[1].
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (String(path).includes('b.jpg')) throw new Error('ENOENT')
      return Buffer.from('fake-image-bytes')
    })
    vi.mocked(extractByLlm).mockResolvedValue({
      ...llmResult,
      // Refers to candidateImages[1], i.e. c.jpg — must land on original
      // index 2, not on b.jpg which never reached the LLM.
      photoCuration: [{ photoIndex: 1, category: 'aussen', caption: 'Garten', isPropertyPhoto: true }],
    })
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))

    const priorEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      photos: basePhotos,
      at: '2026-06-01T00:00:00.000Z',
    }

    const result = await reprocessAuction('zvg-portal', '7265', priorEntry, { baseUrl: 'http://proxy' } as never, '2026-07-22T00:00:00.000Z')

    expect(vi.mocked(extractByLlm).mock.calls[0]?.[0].candidateImages).toHaveLength(2)
    expect(result!.entry.photos?.[0]).toMatchObject({ file: 'a.jpg', category: 'sonstiges' })
    expect(result!.entry.photos?.[1]).toMatchObject({ file: 'b.jpg', category: 'sonstiges' })
    expect(result!.entry.photos?.[2]).toMatchObject({
      file: 'c.jpg',
      category: 'aussen',
      caption: 'Garten',
      isPropertyPhoto: true,
    })
  })
})

describe('runReprocess', () => {
  beforeEach(() => {
    vi.mocked(ensureEnabledCountriesLoaded).mockResolvedValue(['se'])
    vi.mocked(getEnabledCountryCodes).mockReturnValue(['se'])
    vi.mocked(isCountryEnabled).mockImplementation((country) => country === 'se')
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
    expect(result).toEqual({ candidates: 0, processed: 0, skipped: 0, llmCalls: 0, durationMs: expect.any(Number) })
  })

  it('scopes the candidate query to enabled countries plus whatever filters were given', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await runReprocess({ platform: 'zvg-portal', externalId: '7265' })

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("kind = 'auction'")
    expect(sql).toContain('country = $1')
    expect(sql).toContain('platform = $2')
    expect(sql).toContain('external_id = $3')
    expect(params).toEqual(['se', 'zvg-portal', '7265'])
  })

  it('uses all enabled countries when no explicit country is given', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(getEnabledCountryCodes).mockReturnValue(['se', 'dk'])

    await runReprocess({})

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('country = ANY($1)')
    expect(params).toEqual([['se', 'dk']])
  })

  it('uses an explicitly selected country only when that country is enabled', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    await runReprocess({ country: 'SE' })

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('country = $1')
    expect(params).toEqual(['se'])
  })

  it('returns no candidates for an explicitly selected disabled country', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const result = await runReprocess({ country: 'de' })

    expect(result).toEqual({ candidates: 0, processed: 0, skipped: 0, llmCalls: 0, durationMs: expect.any(Number) })
    expect(query).not.toHaveBeenCalled()
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
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: 1,
      condition: 'gepflegt',
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      marketValueEur: null,
      marketValueText: null,
      source: 'llm',
      confidence: 'high',
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': completeEntry })

    const skippedResult = await runReprocess({})
    expect(skippedResult).toEqual({ candidates: 1, processed: 0, skipped: 1, llmCalls: 0, durationMs: expect.any(Number) })
    expect(writeExtractionCache).not.toHaveBeenCalled()

    const forcedResult = await runReprocess({ platform: 'zvg-portal', force: true })
    expect(forcedResult.processed).toBe(1)
    expect(writeExtractionCache).toHaveBeenCalledWith({ 'zvg-portal:7265': expect.objectContaining({ propertyType: 'einfamilienhaus' }) })
  })

  it('counts a rate limit failure as skipped and leaves the cache entry (and llmFailures) untouched', async () => {
    // A capacity outage (see llm.ts's isRateLimitError()) must never count
    // toward MAX_LLM_FAILURES — otherwise a few hours of rate-limiting
    // permanently downgrades every affected auction to rules-only, with no
    // recovery even once the outage clears (the prod incident this guards).
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))
    const auction = makeAuction()
    const query = vi.fn().mockResolvedValue({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(extractByLlm).mockRejectedValue(Object.assign(new Error('http 429'), { response: { status: 429 } }))

    const prior: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      llmFailures: 2,
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': prior })

    const result = await runReprocess({})

    expect(result).toEqual({ candidates: 1, processed: 0, skipped: 1, llmCalls: 0, durationMs: expect.any(Number) })
    expect(writeExtractionCache).not.toHaveBeenCalled()
  })

  it('reprocesses an otherwise-complete entry without force when enrich.ts archived a newer document set', async () => {
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

    const completeButStaleEntry: AuctionExtraction = {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 850,
      livingAreaSqm: 140,
      rooms: 5,
      units: 1,
      condition: 'gepflegt',
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      marketValueEur: null,
      marketValueText: null,
      source: 'llm',
      confidence: 'high',
      documentSetHash: 'old-hash',
      documentSetVersion: 1,
      archivedDocumentSetHash: 'new-hash',
      archivedDocumentSetVersion: 2,
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': completeButStaleEntry })

    const result = await runReprocess({})
    expect(result).toEqual({ candidates: 1, processed: 1, skipped: 0, llmCalls: 0, durationMs: expect.any(Number) })
  })

  it('backfills an entry whose only missing LLM field is renovationNotes', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))
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
    vi.mocked(extractByLlm).mockResolvedValue({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: 'gepflegt',
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: 'Dach erneuert',
      insights: null,
      planningNotes: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })

    const missingRenovationNotesEntry: AuctionExtraction = {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 850,
      livingAreaSqm: 140,
      rooms: 5,
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: 1,
      condition: 'gepflegt',
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      insights: null,
      source: 'llm',
      confidence: 'high',
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': missingRenovationNotesEntry })

    const result = await runReprocess({})
    expect(result).toEqual({ candidates: 1, processed: 1, skipped: 0, llmCalls: 1, durationMs: expect.any(Number) })
    expect(writeExtractionCache).toHaveBeenCalledWith({
      'zvg-portal:7265': expect.objectContaining({ renovationNotes: 'Dach erneuert' }),
    })
  })

  it('submits a batch probe instead of falling back to sync when batch is explicitly requested despite a known-broken provider', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      extractLlm: {
        provider: 'gemini-native',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'test-key',
        model: 'gemini-flash-latest',
        // Free tier's static gate (supportsLlmBatch → isGeminiBatchTierPaid)
        // is unrelated to what this test targets — the known-broken bypass —
        // so pin the tier to paid to isolate that behavior.
        geminiBatchTier: 'paid',
      },
    }))
    vi.mocked(submitLlmBatch).mockResolvedValueOnce(null)
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
    vi.mocked(readExtractionCache).mockResolvedValue({})

    // opts.batch === true is the /settings "Submit via Batch API" checkbox —
    // an explicit recovery probe that must reach the provider even though
    // isLlmBatchProviderBroken would say it's known-broken, or the
    // capability could never clear back to ok:true. Only the
    // executionMode-derived automatic default defers to the known-broken
    // gate and falls back to sync.
    await runReprocess({ batch: true })

    expect(isLlmBatchProviderBroken).not.toHaveBeenCalled()
    expect(submitLlmBatch).toHaveBeenCalled()
    expect(extractByLlm).not.toHaveBeenCalled()
  })

  it('does not select entries only missing LLM-only fields when no LLM provider is configured', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(readExtractionCache).mockResolvedValue({
      'zvg-portal:7265': {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 850,
        livingAreaSqm: 140,
        rooms: 5,
        units: 1,
        source: 'llm',
        confidence: 'high',
        at: '2026-07-01T00:00:00.000Z',
      },
    })

    const result = await runReprocess({})

    expect(result).toEqual({ candidates: 1, processed: 0, skipped: 1, llmCalls: 0, durationMs: expect.any(Number) })
    expect(findLatestCapture).not.toHaveBeenCalled()
    expect(writeExtractionCache).not.toHaveBeenCalled()
  })

  it('backfills an entry whose only missing LLM field is marketValueEur', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy' } }))
    const auction = makeAuction({
      marketValueEur: null,
      marketValueText: null,
      title: 'Gutshaus',
      description: 'Verkehrswert: 78.000,00 €',
    })
    const query = vi.fn().mockResolvedValue({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))
    vi.mocked(extractByLlm).mockResolvedValue({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: null,
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      photoCuration: [],
      marketValueEur: 78_000,
      marketValueText: '78.000,00 €',
    })

    const missingMarketValueEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: null,
      condition: null,
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      source: 'llm',
      confidence: 'low',
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({
      'zvg-portal:7265': missingMarketValueEntry,
    })

    const result = await runReprocess({})

    expect(result).toEqual({ candidates: 1, processed: 1, skipped: 0, llmCalls: 1, durationMs: expect.any(Number) })
    expect(writeExtractionCache).toHaveBeenCalledWith({
      'zvg-portal:7265': expect.objectContaining({
        marketValueEur: 78_000,
        marketValueText: '78.000,00 €',
      }),
    })
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

  it('skips entries that already hit MAX_LLM_FAILURES unless forced', async () => {
    const auction = makeAuction()
    const query = vi.fn().mockResolvedValue({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind) =>
      kind === 'auction' ? { contentHash: 'abc', sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' } : null,
    )
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction)))

    const exhaustedEntry: AuctionExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: null,
      source: 'rules',
      confidence: 'low',
      llmFailures: 3,
      at: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': exhaustedEntry })

    const skippedResult = await runReprocess({})
    expect(skippedResult).toEqual({ candidates: 1, processed: 0, skipped: 1, llmCalls: 0, durationMs: expect.any(Number) })
    expect(writeExtractionCache).not.toHaveBeenCalled()

    const forcedResult = await runReprocess({ platform: 'zvg-portal', force: true })
    expect(forcedResult.processed).toBe(1)
  })

  it('isolates a per-candidate failure so one bad candidate does not drop already-processed results', async () => {
    const auctionA = makeAuction({ externalId: '1' })
    const query = vi.fn().mockResolvedValue({
      rows: [
        { platform: 'zvg-portal', external_id: '1' },
        { platform: 'zvg-portal', external_id: '2' },
      ],
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(findLatestCapture).mockImplementation(async (kind, _platform, externalId) => {
      if (kind !== 'auction') return null
      if (externalId === '2') throw new Error('boom')
      return { contentHash: externalId, sourceUrl: null, capturedAt: '2026-07-01T00:00:00.000Z' }
    })
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auctionA)))

    const result = await runReprocess({})

    expect(result).toEqual({ candidates: 2, processed: 1, skipped: 1, llmCalls: 0, durationMs: expect.any(Number) })
    expect(writeExtractionCache).toHaveBeenCalledWith({
      'zvg-portal:1': expect.objectContaining({ propertyType: null }),
    })
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
      bedrooms: null,
      bathrooms: null,
      floor: null,
      bathroomHasTub: null,
      bathroomHasShower: null,
      heating: null,
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: null,
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { baseUrl: 'http://proxy', maxPerRun: '1' } }))

    const result = await runReprocess({})

    expect(result.processed).toBe(2)
    expect(result.llmCalls).toBe(1)
    expect(extractByLlm).toHaveBeenCalledTimes(1)
  })
})
