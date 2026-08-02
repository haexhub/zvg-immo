import { describe, expect, it } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { applyAuctionExtraction } from './auction-extraction'

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

function extraction(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: 'einfamilienhaus', landAreaSqm: 500, livingAreaSqm: 120,
    rooms: 5, units: 1, source: 'llm', confidence: 'high', at: '2026-08-02T10:00:00.000Z',
    ...overrides,
  }
}

describe('applyAuctionExtraction', () => {
  it('deduplicates and promotes curated photos', () => {
    const value = auction()
    applyAuctionExtraction(value, extraction({
      photos: [
        { file: 'plan.jpg', category: 'grundriss', caption: null, isPropertyPhoto: false },
        { file: 'house.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
        { file: 'house.jpg', category: 'aussen', caption: null, isPropertyPhoto: true },
      ],
    }))
    expect(value.extraction?.photos?.map((photo) => photo.file)).toEqual(['house.jpg', 'plan.jpg'])
    expect(value.thumbnailUrl).toContain('/house.jpg')
    expect(value.photoCount).toBe(2)
  })

  it('does not overwrite a structural EUR value', () => {
    const missing = auction()
    applyAuctionExtraction(missing, extraction({ marketValueEur: 180_000 }))
    expect(missing.marketValueEur).toBe(180_000)

    const structural = auction({ marketValueEur: 200_000 })
    applyAuctionExtraction(structural, extraction({ marketValueEur: 180_000 }))
    expect(structural.marketValueEur).toBe(200_000)
  })
})
