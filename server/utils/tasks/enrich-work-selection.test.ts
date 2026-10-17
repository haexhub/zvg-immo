import { describe, expect, it, vi } from 'vitest'
import type { Auction, CuratedPhoto } from '~/types/auction'
import type { ArtifactVersionRef } from '../artifact-version-state'
import type { AuctionFetchState } from '../auction-fetch-state'
import type { AuctionRecord } from '../auction-record'

vi.mock('../../crawlers/registry', () => ({ platforms: [] }))
vi.mock('../auction-record', () => ({
  iterateAuctionRecords: vi.fn(),
  readAuctionRecordsByKeys: vi.fn(),
}))
vi.mock('../exchange-rate', () => ({ loadRatesOrPegged: vi.fn(async () => ({})) }))
vi.mock('../verkehrswert-cache', () => ({
  cacheKey: (platform: string, externalId: string) => `${platform}:${externalId}`,
  readVerkehrswertCache: vi.fn(async () => ({})),
}))

const { loadScopedRetryResult, prepareEnrichWork, readStoredAuctionSummaries, summarizeRecord } = await import('./enrich-work-selection')

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'dga-ag',
    country: 'de',
    region: 'Sachsen',
    externalId: 'S26-03-009',
    caseNumber: '',
    authority: 'SGA AG',
    title: 'Haus',
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    // A fresh dga-ag crawl (list.ts) never carries attachments/photoUrls —
    // only enrichOne (not run yet at this point) populates them.
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

function fetchState(overrides: Partial<AuctionFetchState> = {}): AuctionFetchState {
  return {
    platform: 'dga-ag',
    externalId: 'S26-03-009',
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    attachments: [],
    photoUrls: null,
    sourceUpdatedIso: null,
    detailFetchedAt: '2026-08-19T18:30:49.000Z',
    enrichClaimedAt: null,
    llmBatchJob: null,
    llmArtifactVersionId: null,
    llmRulesHint: null,
    llmFailures: 0,
    llmLastAttemptedAt: null,
    llmClaimedAt: null,
    photosCheckedAt: '2026-08-19T18:30:49.000Z',
    photoFailures: 0,
    photoLastAttemptedAt: null,
    photoPipelineVersion: 4,
    updatedAt: '2026-08-19T18:30:49.000Z',
    ...overrides,
  }
}

function photo(file: string): CuratedPhoto {
  return { file, category: 'sonstiges', caption: null, isPropertyPhoto: true }
}

function artifactVersion(platform: string, externalId: string): ArtifactVersionRef {
  return { id: 1, platform, externalId, version: 1, setHash: 'hash' }
}

function recordWithPhotos(a: Auction, photoFiles: string[]): AuctionRecord {
  return {
    auction: {
      ...a,
      extraction: {
        propertyType: null,
        landAreaSqm: null,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'low',
        at: '2026-08-19T18:30:49.000Z',
        photos: photoFiles.map(photo),
      },
    },
    detailsId: null,
    detailsVersion: null,
    artifactVersionId: null,
  }
}

describe('prepareEnrichWork needsPhotoBackfill — dga-ag stale-version backfill', () => {
  it('is eligible when photoPipelineVersion is stale, even though the fresh crawl carries no photo hint and photos already exist', async () => {
    const a = auction()
    const key = 'dga-ag:S26-03-009'
    const { needsPhotoBackfill, todo } = await prepareEnrichWork({
      opts: {},
      auctions: [a],
      fetchStates: new Map([[key, fetchState({ photoPipelineVersion: 4 })]]),
      artifactVersions: new Map(),
      stored: new Map([[key, summarizeRecord(recordWithPhotos(a, Array.from({ length: 56 }, (_, i) => `${i}.jpg`)))]]),
    })

    expect(needsPhotoBackfill(a, 'eligibility')).toBe(true)
    expect(todo).toContain(a)
  })

  it('is not eligible once photoPipelineVersion matches the target', async () => {
    const a = auction()
    const key = 'dga-ag:S26-03-009'
    const { needsPhotoBackfill, todo } = await prepareEnrichWork({
      opts: {},
      auctions: [a],
      fetchStates: new Map([[key, fetchState({ photoPipelineVersion: 6 })]]),
      artifactVersions: new Map([[key, artifactVersion('dga-ag', 'S26-03-009')]]),
      stored: new Map([[key, summarizeRecord(recordWithPhotos(a, ['0.jpg']))]]),
    })

    expect(needsPhotoBackfill(a, 'eligibility')).toBe(false)
    expect(todo).not.toContain(a)
  })

  it('does not widen eligibility for other platforms with the same stale-version-but-already-has-photos shape', async () => {
    const a = auction({ platform: 'zvg-portal', externalId: '42' })
    const key = 'zvg-portal:42'
    const { needsPhotoBackfill, todo } = await prepareEnrichWork({
      opts: {},
      auctions: [a],
      fetchStates: new Map([[key, fetchState({ platform: 'zvg-portal', externalId: '42', photoPipelineVersion: 1 })]]),
      artifactVersions: new Map([[key, artifactVersion('zvg-portal', '42')]]),
      stored: new Map([[key, summarizeRecord(recordWithPhotos(a, ['0.jpg']))]]),
    })

    expect(needsPhotoBackfill(a, 'eligibility')).toBe(false)
    expect(todo).not.toContain(a)
  })

  it('does NOT bypass the source check at the extraction phase — a dga-ag auction enrichOne left without any source must not be treated as having one', async () => {
    // Simulates enrichOne throwing (e.g. a transient detail-fetch failure):
    // `a` stays exactly as the fresh crawl left it — no attachments, no
    // photoUrls — even though this is the stale-version backfill scenario
    // that made the auction eligible in the first place. enrich-worker.ts
    // calls needsPhotoBackfill(a) with no second argument here (the
    // 'extraction' default) to decide whether to actually run photo
    // extraction; treating "dga-ag" alone as a source at this point would
    // let the pipeline mark itself done with zero photos, wiping whatever
    // was previously stored.
    const a = auction()
    const key = 'dga-ag:S26-03-009'
    const { needsPhotoBackfill } = await prepareEnrichWork({
      opts: {},
      auctions: [a],
      fetchStates: new Map([[key, fetchState({ photoPipelineVersion: 4 })]]),
      artifactVersions: new Map(),
      stored: new Map([[key, summarizeRecord(recordWithPhotos(a, Array.from({ length: 56 }, (_, i) => `${i}.jpg`)))]]),
    })

    expect(needsPhotoBackfill(a)).toBe(false)
  })
})

describe('stored auction summaries', () => {
  it('keeps only what eligibility and the EUR fallback need', () => {
    const a = auction({ currency: 'HUF', marketValue: 1_000_000, marketValueEur: 2_500 })
    expect(summarizeRecord(recordWithPhotos(a, ['0.jpg', '1.jpg']))).toEqual({
      hasExtraction: true,
      photoCount: 2,
      marketValue: { currency: 'HUF', marketValue: 1_000_000, marketValueEur: 2_500 },
    })
    expect(summarizeRecord({ ...recordWithPhotos(a, []), auction: { ...a, extraction: null } })).toMatchObject({
      hasExtraction: false,
      photoCount: 0,
    })
  })

  it('folds a streamed read into one summary per auction without materializing the records', async () => {
    const { iterateAuctionRecords } = await import('../auction-record')
    const first = auction({ externalId: '1' })
    const second = auction({ platform: 'zvg-portal', externalId: '2' })
    vi.mocked(iterateAuctionRecords).mockImplementation(async function* () {
      yield recordWithPhotos(first, ['0.jpg'])
      yield recordWithPhotos(second, [])
    })

    const summaries = await readStoredAuctionSummaries('de')

    expect(iterateAuctionRecords).toHaveBeenCalledWith('de')
    expect([...summaries.keys()]).toEqual(['dga-ag:1', 'zvg-portal:2'])
    expect(summaries.get('dga-ag:1')?.photoCount).toBe(1)
  })

  it('reads a scoped retry by key, not as a whole-table map', async () => {
    const { readAuctionRecordsByKeys } = await import('../auction-record')
    const a = auction({ externalId: '7' })
    vi.mocked(readAuctionRecordsByKeys).mockResolvedValue(new Map([['dga-ag:7', recordWithPhotos(a, ['0.jpg'])]]))

    const { result, summaries } = await loadScopedRetryResult([{ platform: 'dga-ag', externalId: '7' }], '2026-10-17T00:00:00.000Z')

    expect(readAuctionRecordsByKeys).toHaveBeenCalledWith([{ platform: 'dga-ag', externalId: '7' }])
    expect(result.auctions).toHaveLength(1)
    expect(result.auctions[0]).toMatchObject({ platform: 'dga-ag', externalId: '7' })
    expect(result.countries).toEqual(['de'])
    expect(result.platformsSucceeded).toEqual([])
    expect(summaries.get('dga-ag:7')?.photoCount).toBe(1)
  })
})
