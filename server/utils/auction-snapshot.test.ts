import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { mergePreservedDetail } from './auction-snapshot'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'all',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: '',
    title: 'Einfamilienhaus',
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
    ...overrides,
  }
}

describe('mergePreservedDetail — structured source fields', () => {
  it('preserves source areas and rooms when the fresh crawl lacks them', () => {
    const next = mergePreservedDetail(
      auction(),
      auction({ sourceLivingAreaSqm: 120, sourceLandAreaSqm: 500, sourceRooms: 4 }),
    )
    expect(next.sourceLivingAreaSqm).toBe(120)
    expect(next.sourceLandAreaSqm).toBe(500)
    expect(next.sourceRooms).toBe(4)
  })

  it('keeps fresh source values over the previous ones', () => {
    const next = mergePreservedDetail(
      auction({ sourceLivingAreaSqm: 99, sourceRooms: 3 }),
      auction({ sourceLivingAreaSqm: 120, sourceRooms: 4 }),
    )
    expect(next.sourceLivingAreaSqm).toBe(99)
    expect(next.sourceRooms).toBe(3)
  })
})

describe('mergePreservedDetail — photoUrls and photoCount', () => {
  it('restores the gallery and keeps photoCount consistent with it', () => {
    const next = mergePreservedDetail(
      auction({ photoCount: 1, thumbnailUrl: 'https://x/1.jpg' }),
      auction({ photoCount: 5, photoUrls: ['a', 'b', 'c', 'd', 'e'] }),
    )
    expect(next.photoUrls).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(next.photoCount).toBe(5)
  })

  it('does not lower a higher fresh photoCount when restoring photoUrls', () => {
    const next = mergePreservedDetail(
      auction({ photoCount: 7 }),
      auction({ photoUrls: ['a', 'b'] }),
    )
    expect(next.photoUrls).toEqual(['a', 'b'])
    expect(next.photoCount).toBe(7)
  })

  it('keeps a fresh non-empty gallery', () => {
    const next = mergePreservedDetail(
      auction({ photoUrls: ['new'], photoCount: 1 }),
      auction({ photoUrls: ['old1', 'old2'], photoCount: 2 }),
    )
    expect(next.photoUrls).toEqual(['new'])
    expect(next.photoCount).toBe(1)
  })
})

describe('mergePreservedDetail — coordinates', () => {
  it('restores lat/lng as a pair', () => {
    const next = mergePreservedDetail(auction(), auction({ lat: 48.9, lng: 8.5 }))
    expect(next.lat).toBe(48.9)
    expect(next.lng).toBe(8.5)
  })

  it('does not restore a previous half-pair', () => {
    const next = mergePreservedDetail(auction(), auction({ lat: 48.9, lng: null }))
    expect(next.lat).toBeUndefined()
  })

  it('keeps fresh coordinates', () => {
    const next = mergePreservedDetail(
      auction({ lat: 1, lng: 2 }),
      auction({ lat: 48.9, lng: 8.5 }),
    )
    expect(next.lat).toBe(1)
    expect(next.lng).toBe(2)
  })
})

describe('mergePreservedDetail — caseNumber', () => {
  it('restores a previously known caseNumber when the re-crawl lost it', () => {
    expect(mergePreservedDetail(auction({ caseNumber: '' }), auction()).caseNumber).toBe(
      '1 K 1/26',
    )
  })

  it('keeps a fresh caseNumber', () => {
    const next = mergePreservedDetail(auction({ caseNumber: '2 K 9/26' }), auction())
    expect(next.caseNumber).toBe('2 K 9/26')
  })
})

describe('mergePreservedDetail — description', () => {
  it('restores the description when the fresh crawl has none', () => {
    const next = mergePreservedDetail(auction(), auction({ description: 'Alt' }))
    expect(next.description).toBe('Alt')
  })

  it('keeps the enriched extension when it starts with the fresh list text', () => {
    const next = mergePreservedDetail(
      auction({ description: 'Listentext.' }),
      auction({
        description: 'Listentext.\nKadastra apzīmējums: 0100 012 0345',
        detailFetchedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    expect(next.description).toBe('Listentext.\nKadastra apzīmējums: 0100 012 0345')
  })

  it('does not restore an extension the detail fetch never produced', () => {
    // prev longer but never detail-fetched → could be stale list text; keep next.
    const next = mergePreservedDetail(
      auction({ description: 'Listentext.' }),
      auction({ description: 'Listentext.\nMehr' }),
    )
    expect(next.description).toBe('Listentext.')
  })

  it('keeps a genuinely changed fresh description', () => {
    const next = mergePreservedDetail(
      auction({ description: 'Neuer Text' }),
      auction({
        description: 'Alter Text mit Anhang',
        detailFetchedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    expect(next.description).toBe('Neuer Text')
  })
})
