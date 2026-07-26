import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { calculateAuctionPricePerSqm, calculatePricePerSqm, classifyMarketPropertyClass } from './market'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Berlin',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: 300_000,
    marketValueText: '300.000 EUR',
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

describe('calculatePricePerSqm', () => {
  it('prefers living area over land area', () => {
    expect(calculatePricePerSqm({
      marketValueEur: 300_000,
      livingAreaSqm: 100,
      landAreaSqm: 600,
    })).toEqual({ pricePerSqm: 3000, basis: 'livingArea', areaSqm: 100 })
  })

  it('falls back to land area when living area is missing', () => {
    expect(calculatePricePerSqm({
      marketValueEur: 300_000,
      livingAreaSqm: null,
      landAreaSqm: 600,
    })).toEqual({ pricePerSqm: 500, basis: 'landArea', areaSqm: 600 })
  })

  it('does not compare without market value or usable area', () => {
    expect(calculatePricePerSqm({ marketValueEur: null, livingAreaSqm: 100, landAreaSqm: 600 })).toBeNull()
    expect(calculatePricePerSqm({ marketValueEur: 300_000, livingAreaSqm: 0, landAreaSqm: null })).toBeNull()
  })
})

describe('calculateAuctionPricePerSqm', () => {
  it('uses extraction areas before source fallback areas', () => {
    expect(calculateAuctionPricePerSqm(auction({
      sourceLivingAreaSqm: 120,
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: null,
        livingAreaSqm: 100,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'high',
        at: '2026-07-26T00:00:00.000Z',
      },
    }))?.pricePerSqm).toBe(3000)
  })
})

describe('classifyMarketPropertyClass', () => {
  it('maps residential and land extraction types to market classes', () => {
    expect(classifyMarketPropertyClass(auction({
      extraction: {
        propertyType: 'eigentumswohnung',
        landAreaSqm: null,
        livingAreaSqm: 80,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'high',
        at: '2026-07-26T00:00:00.000Z',
      },
    }))).toBe('apartment')
    expect(classifyMarketPropertyClass(auction({
      extraction: {
        propertyType: 'unbebaut',
        landAreaSqm: 500,
        livingAreaSqm: null,
        rooms: null,
        units: null,
        source: 'rules',
        confidence: 'high',
        at: '2026-07-26T00:00:00.000Z',
      },
    }))).toBe('land')
  })
})
