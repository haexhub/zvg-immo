import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { mergeStoredAuction } from './auction-merge'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test', country: 'de', region: 'be', externalId: '42', caseNumber: '1 K 1/26',
    authority: 'AG Test', title: 'Haus', address: null, marketValueEur: null,
    marketValueText: null, auctionDateIso: null, auctionDateText: null, cancelled: false,
    sourceUpdatedIso: null, pdfUrl: null, pdfUrlUpstream: null, detailUrl: null,
    detailUrlUpstream: null, attachments: [], description: null, photoCount: 0,
    thumbnailUrl: null, ...overrides,
  }
}

describe('mergeStoredAuction', () => {
  it('preserves detail-only fields during a list crawl', () => {
    const previous = auction({
      description: 'Ausführliche Beschreibung', detailFetchedAt: '2026-08-01T10:00:00.000Z',
      sourceLivingAreaSqm: 120, photoUrls: ['one.jpg', 'two.jpg'], lat: 52.5, lng: 13.4,
    })
    const merged = mergeStoredAuction(auction(), previous)
    expect(merged.description).toBe(previous.description)
    expect(merged.sourceLivingAreaSqm).toBe(120)
    expect(merged.photoCount).toBe(2)
    expect([merged.lat, merged.lng]).toEqual([52.5, 13.4])
  })

  it('does not restore mutable current bids', () => {
    expect(mergeStoredAuction(auction(), auction({ currentBid: 90_000 })).currentBid).toBeUndefined()
  })
})
