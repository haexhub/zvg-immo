import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import type { LocationEnrichmentCache } from '~/server/utils/external-data/location-enrichment'
import { inScope, orderByStaleness } from './external-enrichment-scope'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'fr',
    region: 'Paris',
    externalId: '42',
    caseNumber: 'FR-42',
    authority: 'Tribunal',
    title: 'Maison',
    address: 'Paris',
    marketValueEur: 400_000,
    marketValueText: '400.000 EUR',
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
    lat: 48.8566,
    lng: 2.3522,
    ...overrides,
  }
}

describe('orderByStaleness', () => {
  it('puts never-checked auctions ahead of any previously-checked one', () => {
    const checked = auction({ externalId: 'checked' })
    const neverChecked = auction({ externalId: 'never' })
    const existing = {
      'test:checked': { checkedAt: '2026-08-18T00:00:00.000Z' },
    } as unknown as LocationEnrichmentCache

    const ordered = orderByStaleness([checked, neverChecked], existing)

    expect(ordered.map((a) => a.externalId)).toEqual(['never', 'checked'])
  })

  it('orders previously-checked auctions oldest checkedAt first', () => {
    const older = auction({ externalId: 'older' })
    const newer = auction({ externalId: 'newer' })
    const existing = {
      'test:older': { checkedAt: '2026-08-01T00:00:00.000Z' },
      'test:newer': { checkedAt: '2026-08-18T00:00:00.000Z' },
    } as unknown as LocationEnrichmentCache

    const ordered = orderByStaleness([newer, older], existing)

    expect(ordered.map((a) => a.externalId)).toEqual(['older', 'newer'])
  })

  it('does not mutate the input array', () => {
    const first = auction({ externalId: 'a' })
    const second = auction({ externalId: 'b' })
    const input = [first, second]

    orderByStaleness(input, {} as LocationEnrichmentCache)

    expect(input).toEqual([first, second])
  })
})

describe('inScope', () => {
  const a = auction({ country: 'de', platform: 'x', externalId: '1' })

  it('matches everything when no filter is given', () => {
    expect(inScope(a, {})).toBe(true)
  })

  it('filters by country case-insensitively', () => {
    expect(inScope(a, { country: 'DE' })).toBe(true)
    expect(inScope(a, { country: 'fr' })).toBe(false)
  })

  it('filters by platform and externalId', () => {
    expect(inScope(a, { platform: 'x' })).toBe(true)
    expect(inScope(a, { platform: 'y' })).toBe(false)
    expect(inScope(a, { externalId: '1' })).toBe(true)
    expect(inScope(a, { externalId: '2' })).toBe(false)
  })
})
