import { describe, expect, it, vi } from 'vitest'
import type { Auction, CuratedPhoto } from '~/types/auction'
import type { ArtifactVersionRef } from '../utils/artifact-version-state'
import type { AuctionFetchState } from '../utils/auction-fetch-state'
import type { AuctionRecord } from '../utils/auction-record'

vi.mock('../crawlers/registry', () => ({ platforms: [] }))
vi.mock('../utils/exchange-rate', () => ({ getRates: vi.fn(async () => ({})) }))
vi.mock('../utils/verkehrswert-cache', () => ({
  cacheKey: (platform: string, externalId: string) => `${platform}:${externalId}`,
  readVerkehrswertCache: vi.fn(async () => ({})),
}))

const { prepareEnrichWork } = await import('./enrich-work-selection')

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
      records: new Map([[key, recordWithPhotos(a, Array.from({ length: 56 }, (_, i) => `${i}.jpg`))]]),
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
      records: new Map([[key, recordWithPhotos(a, ['0.jpg'])]]),
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
      records: new Map([[key, recordWithPhotos(a, ['0.jpg'])]]),
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
      records: new Map([[key, recordWithPhotos(a, Array.from({ length: 56 }, (_, i) => `${i}.jpg`))]]),
    })

    expect(needsPhotoBackfill(a)).toBe(false)
  })
})
