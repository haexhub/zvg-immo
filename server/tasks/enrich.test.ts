import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { downloadNativeImages } from '../utils/extract/native-images'
import { extractDocumentPhotos } from '../utils/extract/document-images'
import { readExtractionCache, writeExtractionCache, type ExtractionCache } from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { readVerkehrswertCache } from '../utils/verkehrswert-cache'
import { archiveAuction, archiveDocumentSet } from '../utils/raw-archive'
import { deriveMarketValueEur } from '../utils/exchange-rate'

// WP-1 (docs/plans/2026-07-24-de-crawler-pipeline-reliability-plan.md): the
// photo pipeline must retry a listing whose cache entry never recorded a
// checked photo attempt, but leave a listing that already completed one
// alone — this is what these mocks exist to isolate and observe.
vi.mock('../crawlers/registry', () => ({ crawlAll: vi.fn(), platforms: [] }))
vi.mock('../utils/db', () => ({ getPool: vi.fn(() => null) }))
vi.mock('../utils/exchange-rate', () => ({
  getRates: vi.fn(async () => ({})),
  deriveMarketValueEur: vi.fn(),
}))
vi.mock('../utils/extract/native-images', () => ({ downloadNativeImages: vi.fn() }))
vi.mock('../utils/extract/document-images', () => ({ extractDocumentPhotos: vi.fn(async () => []) }))
// Document text/native-doc preparation is irrelevant to this crawl/archive-only
// task (only used here to build the bytes archiveDocumentSet stores) — default
// to "nothing to archive" so tests that don't care about document-set
// bookkeeping don't need a real network fetch to succeed.
vi.mock('../utils/extract/llm-documents', () => ({
  prepareLiveLlmDocuments: vi.fn(async () => ({ documentSetItems: [], documentSetComplete: false })),
}))
vi.mock('../utils/extraction-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extraction-cache')>()
  return { ...actual, readExtractionCache: vi.fn(), writeExtractionCache: vi.fn(async () => true) }
})
vi.mock('../utils/auction-snapshot', () => ({
  readAuctionSnapshot: vi.fn(async () => ({})),
  writeAuctionSnapshot: vi.fn(),
}))
vi.mock('../utils/verkehrswert-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/verkehrswert-cache')>()
  return { ...actual, readVerkehrswertCache: vi.fn(async () => ({})) }
})
vi.mock('../utils/raw-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/raw-archive')>()
  return {
    ...actual,
    archiveAuction: vi.fn(),
    archiveDocumentSet: vi.fn(async () => null),
  }
})
// defineTask is a Nitro auto-import — stub so importing the module (which
// calls it at the top level for the default export) doesn't throw. Same
// pattern as reprocess.test.ts.
vi.stubGlobal('defineTask', (def: unknown) => def)
vi.stubGlobal('useRuntimeConfig', () => ({}))

const { runEnrich } = await import('./enrich')

const AT_PLATFORM = {
  id: 'zvg-portal',
  name: 'zvg-portal',
  baseUrl: 'https://zvg-portal.de',
  country: 'de',
  regions: [{ code: 'all', name: 'Berlin' }],
  crawl: vi.fn(),
  // No enrichOne — the listing is already fully detail-fetched; this test is
  // only about the photo backfill, not the detail-fetch pipeline.
}

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Berlin',
    externalId: '14409',
    caseNumber: '70 K 7/25',
    authority: 'AG Köpenick',
    title: null,
    address: 'Paradiesstraße 214-218, Berlin-Köpenick',
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: '2026-09-01T09:00:00.000Z',
    auctionDateText: '01.09.2026',
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
    photoUrls: ['https://zvg-portal.de/foto1.jpg'],
    ...overrides,
  }
}

function mockCrawl(auctions: Auction[]) {
  return {
    platform: 'multi',
    source: 'test',
    countries: ['de'],
    regions: [],
    fetchedAt: '2026-07-24T00:00:00.000Z',
    totalReported: null,
    auctions,
    errors: [] as { country: string; region: string; message: string }[],
  }
}

beforeEach(async () => {
  vi.stubGlobal('useRuntimeConfig', () => ({}))
  const { platforms } = await import('../crawlers/registry')
  const mutablePlatforms = platforms as unknown as (typeof AT_PLATFORM)[]
  mutablePlatforms.length = 0
  mutablePlatforms.push(AT_PLATFORM)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runEnrich country scoping', () => {
  it('passes an explicit country through to crawlAll for a manual per-country trigger', async () => {
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([]))
    vi.mocked(readExtractionCache).mockResolvedValue({})

    await runEnrich({ country: 'se' })

    expect(crawlAll).toHaveBeenCalledWith(expect.objectContaining({ country: 'se' }))
  })

  it('omits country from crawlAll when no scope is given (scheduled cron behavior)', async () => {
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([]))
    vi.mocked(readExtractionCache).mockResolvedValue({})

    await runEnrich()

    expect(crawlAll).toHaveBeenCalledWith(expect.objectContaining({ country: undefined }))
  })
})

describe('runEnrich detail post-processing without enrichOne', () => {
  it('still archives, EUR-converts and stamps detailFetchedAt for a crawler with no enrichOne (e.g. se-kronofogden)', async () => {
    const auction = makeAuction()
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))
    vi.mocked(readExtractionCache).mockResolvedValue({})

    await runEnrich()

    expect(archiveAuction).toHaveBeenCalledWith(auction, expect.any(String))
    expect(deriveMarketValueEur).toHaveBeenCalledWith(auction, expect.anything())
    const snapshotted = vi.mocked(writeAuctionSnapshot).mock.calls[0]?.[0] as Auction[]
    expect(typeof snapshotted[0]?.detailFetchedAt).toBe('string')
  })
})

describe('runEnrich photo backfill (WP-1)', () => {
  it('writes archivedDocumentSetHash from a freshly archived set while leaving parse-owned fields untouched', async () => {
    const auction = makeAuction({
      title: 'Unklare Immobilie',
      description: 'Detailtext ohne verwertbare Flaechen.',
      photoUrls: [],
      attachments: [
        {
          kind: 'appraisal',
          label: 'Gutachten',
          filename: 'Gutachten.pdf',
          sizeBytes: 100,
          fileId: '1',
          proxyUrl: 'https://example.test/gutachten.pdf',
        },
      ],
    })
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))
    const { prepareLiveLlmDocuments } = await import('../utils/extract/llm-documents')
    vi.mocked(prepareLiveLlmDocuments).mockResolvedValueOnce({
      documentSetItems: [
        {
          ordinal: 0,
          kind: 'document',
          label: 'Gutachten',
          filename: 'Gutachten.pdf',
          fileId: '1',
          sourceUrl: 'https://example.test/gutachten.pdf',
          contentHash: 'hash-1',
          contentType: 'application/pdf',
        },
      ],
      documentSetComplete: true,
    })
    vi.mocked(archiveDocumentSet).mockResolvedValueOnce({
      setHash: 'fresh-set',
      version: 2,
      changed: true,
    })

    // archivedDocumentSetHash absent — this task has never archived a
    // document set for this auction yet, so needsDocumentSetCheck is due.
    // condition/source/confidence/llmFailures/documentSetHash are already
    // set though — a fully separate task (reprocess.ts) owns them and must
    // see them unchanged, even though enrich.ts rewrites this same cache row
    // for its own (archivedDocumentSetHash/photo) fields.
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        rooms: 4,
        units: 1,
        source: 'llm',
        confidence: 'high',
        condition: 'gepflegt',
        llmFailures: 1,
        documentSetHash: 'prior-set',
        documentSetVersion: 1,
        photosCheckedAt: '2026-07-20T00:00:00.000Z',
        photoPipelineVersion: 3,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)

    await runEnrich()

    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    const entry = written['zvg-portal:14409']
    expect(entry?.archivedDocumentSetHash).toBe('fresh-set')
    expect(entry?.archivedDocumentSetVersion).toBe(2)
    // Untouched — reprocess.ts owns these.
    expect(entry?.condition).toBe('gepflegt')
    expect(entry?.source).toBe('llm')
    expect(entry?.confidence).toBe('high')
    expect(entry?.llmFailures).toBe(1)
    expect(entry?.documentSetHash).toBe('prior-set')
  })

  it('retries the document-set check after a previously failed archive attempt (archivedDocumentSetHash: null)', async () => {
    const auction = makeAuction({
      title: 'Unklare Immobilie',
      description: 'Detailtext ohne verwertbare Flaechen.',
      photoUrls: [],
      attachments: [
        {
          kind: 'appraisal',
          label: 'Gutachten',
          filename: 'Gutachten.pdf',
          sizeBytes: 100,
          fileId: '1',
          proxyUrl: 'https://example.test/gutachten.pdf',
        },
      ],
    })
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))
    const { prepareLiveLlmDocuments } = await import('../utils/extract/llm-documents')
    vi.mocked(prepareLiveLlmDocuments).mockResolvedValueOnce({
      documentSetItems: [
        {
          ordinal: 0,
          kind: 'document',
          label: 'Gutachten',
          filename: 'Gutachten.pdf',
          fileId: '1',
          sourceUrl: 'https://example.test/gutachten.pdf',
          contentHash: 'hash-1',
          contentType: 'application/pdf',
        },
      ],
      documentSetComplete: true,
    })
    vi.mocked(archiveDocumentSet).mockResolvedValueOnce({
      setHash: 'retried-set',
      version: 1,
      changed: true,
    })

    // A prior run's archive attempt failed and recorded `null` (not
    // `undefined`) — needsDocumentSetCheck must still treat this as due, or a
    // failed archive would permanently exclude the listing from retries.
    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        archivedDocumentSetHash: null,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)

    await runEnrich()

    expect(archiveDocumentSet).toHaveBeenCalled()
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.archivedDocumentSetHash).toBe('retried-set')
  })

  it('re-attempts the photo pipeline for an entry with no photos and no photosCheckedAt marker', async () => {
    const auction = makeAuction()
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: undefined,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(downloadNativeImages).mockResolvedValue(['foto1.jpg'])

    await runEnrich()

    expect(downloadNativeImages).toHaveBeenCalledTimes(1)
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.photos).toBeUndefined()
    expect(written['zvg-portal:14409']?.photosCheckedAt).toBeTruthy()
    expect(written['zvg-portal:14409']?.photoPipelineVersion).toBe(3)
  })

  it('does not re-attempt the photo pipeline once photosCheckedAt is set for the current pipeline version', async () => {
    const auction = makeAuction()
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: '2026-07-20T00:00:00.000Z',
        photoPipelineVersion: 3,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)

    await runEnrich()

    expect(downloadNativeImages).not.toHaveBeenCalled()
  })

  it('does not re-attempt unchanged native-photo entries from other platforms just because Kronofogden moved to version 5', async () => {
    const auction = makeAuction({
      photoUrls: ['https://zvg-portal.de/foto1.jpg'],
    })
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: 'einfamilienhaus',
        landAreaSqm: null,
        livingAreaSqm: 100,
        rooms: null,
        units: null,
        source: 'llm',
        confidence: 'high',
        photos: [{ file: 'foto1.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: true }],
        photosCheckedAt: '2026-07-20T00:00:00.000Z',
        photoPipelineVersion: 3,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)

    await runEnrich()

    expect(downloadNativeImages).not.toHaveBeenCalled()
    expect(writeExtractionCache).not.toHaveBeenCalled()
  })

  it('re-attempts old confirmed-empty photo checks once when the pipeline version changes', async () => {
    const auction = makeAuction()
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: '2026-07-20T00:00:00.000Z',
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(downloadNativeImages).mockResolvedValue(['foto1.jpg'])

    await runEnrich()

    expect(downloadNativeImages).toHaveBeenCalledTimes(1)
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.photoPipelineVersion).toBe(3)
  })

  it('bumps photoFailures and leaves photosCheckedAt unset when the pipeline throws', async () => {
    const auction = makeAuction()
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: undefined,
        photoFailures: 1,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(downloadNativeImages).mockRejectedValue(new Error('network hiccup'))

    await runEnrich()

    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.photosCheckedAt).toBeUndefined()
    expect(written['zvg-portal:14409']?.photoFailures).toBe(2)
  })

  it('persists a photo-only outcome even when rules are unconfident and detail-fetch fails', async () => {
    // Regression for a gap where photosCheckedAt/photoFailures were silently
    // dropped: cacheable used to depend only on mergedConfident/detailOk, so
    // a listing whose only successful pipeline this run was the photo
    // backfill (rules unconfident, no LLM configured, enrichOne failing)
    // never got persisted and was retried forever.
    const platformWithFailingDetail = {
      ...AT_PLATFORM,
      enrichOne: vi.fn(async () => {
        throw new Error('detail fetch failed')
      }),
    }
    const { platforms, crawlAll } = await import('../crawlers/registry')
    const mutablePlatforms = platforms as unknown as (typeof AT_PLATFORM)[]
    mutablePlatforms.length = 0
    mutablePlatforms.push(platformWithFailingDetail)

    const auction = makeAuction()
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: undefined,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(downloadNativeImages).mockResolvedValue(['foto1.jpg'])

    await runEnrich()

    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.photosCheckedAt).toBeTruthy()
  })

  it('stops retrying once photoFailures reaches the bound', async () => {
    const auction = makeAuction()
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: undefined,
        photoFailures: 3,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)

    await runEnrich()

    expect(downloadNativeImages).not.toHaveBeenCalled()
  })

  it('passes every document attachment to the central document photo miner', async () => {
    // Regression: photo extraction used to have a PDF-only candidate list in
    // enrich.ts. All document formats now flow through document-images.ts so
    // PDF/DOCX/HTML improvements apply to every crawler at once.
    const auction = makeAuction({
      photoUrls: [],
      attachments: [
        {
          kind: 'appraisal',
          label: 'Gutachten',
          filename: 'Gutachten_Teil 1.pdf',
          sizeBytes: 100,
          fileId: '1',
          proxyUrl: '/api/zvg-proxy?file_id=1',
        },
        {
          kind: 'appraisal',
          label: 'Gutachten',
          filename: 'Anlagen.pdf',
          sizeBytes: 100,
          fileId: '2',
          proxyUrl: '/api/zvg-proxy?file_id=2',
        },
      ],
    })
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: undefined,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(extractDocumentPhotos).mockResolvedValueOnce(['abc123.jpg'])

    await runEnrich()

    expect(extractDocumentPhotos).toHaveBeenCalledTimes(1)
    expect(vi.mocked(extractDocumentPhotos).mock.calls[0]?.[0]).toBe(auction.attachments)
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.photos).toEqual([
      { file: 'abc123.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: true },
    ])
    expect(written['zvg-portal:14409']?.photosCheckedAt).toBeTruthy()
  })

  it('mines PDFs when photoCount is positive but no native photos were downloaded', async () => {
    // Regression for se-kronofogden: the crawler can see upstream preview
    // images and set photoCount > 0 without providing download-ready
    // photoUrls. That must not block mining the attached appraisal PDF.
    const auction = makeAuction({
      photoCount: 1,
      photoUrls: [],
      thumbnailUrl: 'https://auktionstorget.kronofogden.se/images/thumb.jpg',
      attachments: [
        {
          kind: 'appraisal',
          label: 'Beskrivning och värdering',
          filename: 'BOV.pdf',
          sizeBytes: 100,
          fileId: 'bov',
          proxyUrl: 'https://auktionstorget.kronofogden.se/download/BOV.pdf',
        },
      ],
    })
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'zvg-portal:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: undefined,
        photosCheckedAt: undefined,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(extractDocumentPhotos).mockResolvedValueOnce(['bov-photo.jpg'])

    await runEnrich()

    expect(extractDocumentPhotos).toHaveBeenCalledTimes(1)
    expect(vi.mocked(extractDocumentPhotos).mock.calls[0]?.[0]).toBe(auction.attachments)
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['zvg-portal:14409']?.photos).toEqual([
      { file: 'bov-photo.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: true },
    ])
    expect(written['zvg-portal:14409']?.photoPipelineVersion).toBe(3)
  })

  it('rebuilds legacy native-gallery entries with hash-deduped document photos', async () => {
    const auction = makeAuction({
      platform: 'se-kronofogden',
      photoUrls: ['https://auktionstorget.kronofogden.se/images/200.abc/1/Bild%201.jpg'],
      attachments: [
        {
          kind: 'appraisal',
          label: 'Beskrivning och värdering',
          filename: 'BOV.pdf',
          sizeBytes: 100,
          fileId: 'bov',
          proxyUrl: 'https://auktionstorget.kronofogden.se/download/BOV.pdf',
        },
      ],
    })
    const { crawlAll } = await import('../crawlers/registry')
    vi.mocked(crawlAll).mockResolvedValue(mockCrawl([auction]))

    const cache: ExtractionCache = {
      'se-kronofogden:14409': {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        photos: [{ file: 'pdf-photo.jpg', category: 'aussen', caption: 'PDF', isPropertyPhoto: true }],
        photosCheckedAt: '2026-07-20T00:00:00.000Z',
        photoPipelineVersion: 2,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)
    vi.mocked(downloadNativeImages).mockResolvedValue(['1111111111111111.jpg'])
    vi.mocked(extractDocumentPhotos).mockResolvedValue(['1111111111111111.jpg', '2222222222222222.jpg'])

    await runEnrich()

    expect(downloadNativeImages).toHaveBeenCalledTimes(1)
    expect(extractDocumentPhotos).toHaveBeenCalledTimes(1)
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['se-kronofogden:14409']?.photos).toEqual([
      { file: '2222222222222222.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: true },
    ])
    expect(written['se-kronofogden:14409']?.photoPipelineVersion).toBe(5)
  })
})
