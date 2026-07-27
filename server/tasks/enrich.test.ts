import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { downloadNativeImages } from '../utils/extract/native-images'
import { extractDocumentPhotos } from '../utils/extract/document-images'
import { readExtractionCache, writeExtractionCache, type ExtractionCache } from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { readVerkehrswertCache } from '../utils/verkehrswert-cache'

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
  const { platforms } = await import('../crawlers/registry')
  const mutablePlatforms = platforms as unknown as (typeof AT_PLATFORM)[]
  mutablePlatforms.length = 0
  mutablePlatforms.push(AT_PLATFORM)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runEnrich photo backfill (WP-1)', () => {
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
    expect(written['zvg-portal:14409']?.photos).toEqual([
      { file: 'foto1.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: true },
    ])
    expect(written['zvg-portal:14409']?.photosCheckedAt).toBeTruthy()
    expect(written['zvg-portal:14409']?.photoPipelineVersion).toBe(2)
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
        photoPipelineVersion: 2,
        at: '2026-07-01T00:00:00.000Z',
      },
    }
    vi.mocked(readExtractionCache).mockResolvedValue(cache)

    await runEnrich()

    expect(downloadNativeImages).not.toHaveBeenCalled()
  })

  it('does not re-attempt unchanged native-photo entries from other platforms just because Kronofogden moved to version 3', async () => {
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
        photoPipelineVersion: 2,
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
    expect(written['zvg-portal:14409']?.photoPipelineVersion).toBe(2)
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
    expect(written['zvg-portal:14409']?.photoPipelineVersion).toBe(2)
  })

  it('merges newly exposed native gallery photos into existing document photos', async () => {
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
    vi.mocked(downloadNativeImages).mockResolvedValue(['native-photo.jpg'])

    await runEnrich()

    expect(downloadNativeImages).toHaveBeenCalledTimes(1)
    expect(extractDocumentPhotos).not.toHaveBeenCalled()
    const written = vi.mocked(writeExtractionCache).mock.calls[0]?.[0] as ExtractionCache
    expect(written['se-kronofogden:14409']?.photos).toEqual([
      { file: 'pdf-photo.jpg', category: 'aussen', caption: 'PDF', isPropertyPhoto: true },
      { file: 'native-photo.jpg', category: 'sonstiges', caption: null, isPropertyPhoto: true },
    ])
    expect(written['se-kronofogden:14409']?.photoPipelineVersion).toBe(3)
  })
})
