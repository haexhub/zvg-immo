import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { completenessScore, dedupeRegionAuctions, frAddressDateKey } from './dedupe'

function auction(overrides: Partial<Auction>): Auction {
  return {
    platform: 'fr-licitor',
    country: 'fr',
    region: '',
    externalId: 'x',
    caseNumber: '',
    authority: '',
    title: null,
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

describe('frAddressDateKey', () => {
  it('builds a {postal, houseNumber, date} fingerprint for a normal street address', () => {
    expect(
      frAddressDateKey(
        auction({ address: "129 Bd d'Aulnay, 93250 Villemomble", auctionDateIso: '2026-07-07T14:00:00' }),
      ),
    ).toBe('fr-addr|93250|129|2026-07-07')
  })

  it('keeps a letter-suffixed house number (e.g. "5B")', () => {
    expect(
      frAddressDateKey(
        auction({ address: '5B Chem. de Thenières, 74140 Massongy', auctionDateIso: '2026-08-28T15:00:00' }),
      ),
    ).toBe('fr-addr|74140|5B|2026-08-28')
  })

  it('returns null for a postal-code-only address with no house number, instead of using the postal code as one', () => {
    expect(frAddressDateKey(auction({ address: '56930 Pluméliau-Bieuzy', auctionDateIso: '2026-07-06T10:30:00' }))).toBeNull()
  })

  it('returns null when country is not fr', () => {
    expect(
      frAddressDateKey(
        auction({ country: 'at', address: '12 Rue de la Paix, 75001 Paris', auctionDateIso: '2026-07-07T14:00:00' }),
      ),
    ).toBeNull()
  })

  it('returns null when address or auctionDateIso is missing', () => {
    expect(frAddressDateKey(auction({ address: null, auctionDateIso: '2026-07-07T14:00:00' }))).toBeNull()
    expect(frAddressDateKey(auction({ address: '12 Rue de la Paix, 75001 Paris', auctionDateIso: null }))).toBeNull()
  })
})

describe('completenessScore', () => {
  it('scores a fuller record higher than a bare-bones one', () => {
    const bare = auction({})
    const full = auction({
      marketValueEur: 100_000,
      title: 'Maison',
      address: '12 Rue de la Paix, 75001 Paris',
      auctionDateIso: '2026-07-07T14:00:00',
      description: 'Une belle maison.',
      photoCount: 3,
    })
    expect(completenessScore(full)).toBeGreaterThan(completenessScore(bare))
  })

  it('caps the photo-count contribution so a photo-only record cannot outscore a described one', () => {
    const manyPhotosNoText = auction({ photoCount: 50 })
    const describedFewPhotos = auction({
      marketValueEur: 100_000,
      title: 'Maison',
      address: '12 Rue de la Paix, 75001 Paris',
      auctionDateIso: '2026-07-07T14:00:00',
      description: 'Une belle maison.',
      photoCount: 1,
    })
    expect(completenessScore(describedFewPhotos)).toBeGreaterThan(completenessScore(manyPhotosNoText))
  })
})

describe('dedupeRegionAuctions', () => {
  const ids = (auctions: Auction[]) => auctions.map((a) => `${a.platform}:${a.externalId}`).sort()

  it('keeps distinct lots of one platform that share an Aktenzeichen', () => {
    const lots = [1, 2, 3].map((n) =>
      auction({ platform: 'it-agi', country: 'it', externalId: String(n), caseNumber: '262', authority: 'Ragusa' }),
    )

    expect(ids(dedupeRegionAuctions(lots))).toEqual(['it-agi:1', 'it-agi:2', 'it-agi:3'])
  })

  it('collapses a cross-platform Aktenzeichen match to the platform with the most lots', () => {
    const shared = { country: 'de', caseNumber: '1 K 5/26', authority: 'AG Stuttgart' }
    const result = dedupeRegionAuctions([
      auction({ ...shared, platform: 'zvg-portal', externalId: 'a', title: 'Haus', description: 'Text' }),
      auction({ ...shared, platform: 'zvg-portal', externalId: 'b', title: 'Garage' }),
      auction({ ...shared, platform: 'zvbawu', externalId: 'z' }),
    ])

    expect(ids(result)).toEqual(['zvg-portal:a', 'zvg-portal:b'])
  })

  it('keeps the platform with more lots even when another platform has the richer single record', () => {
    const shared = { country: 'de', caseNumber: '1 K 7/26', authority: 'AG Stuttgart' }
    const result = dedupeRegionAuctions([
      auction({ ...shared, platform: 'zvbawu', externalId: 'z', title: 'Haus', description: 'Text', photoCount: 5 }),
      ...['a', 'b', 'c'].map((externalId) => auction({ ...shared, platform: 'zvg-portal', externalId })),
    ])

    expect(ids(result)).toEqual(['zvg-portal:a', 'zvg-portal:b', 'zvg-portal:c'])
  })

  it('lets the richer record win a cross-platform tie in lot count', () => {
    const shared = { country: 'de', caseNumber: '1 K 8/26', authority: 'AG Stuttgart' }
    const result = dedupeRegionAuctions([
      auction({ ...shared, platform: 'zvg-portal', externalId: 'a' }),
      auction({ ...shared, platform: 'zvbawu', externalId: 'z', title: 'Haus' }),
    ])

    expect(ids(result)).toEqual(['zvbawu:z'])
  })

  it('drops repeated {platform, externalId} rows', () => {
    const row = auction({ externalId: '7', caseNumber: '262', authority: 'Ragusa' })

    expect(dedupeRegionAuctions([row, { ...row }])).toHaveLength(1)
  })

  it('keeps same-platform FR lots sharing an address fingerprint but collapses cross-platform copies', () => {
    const sale = { address: '12 Rue de la Paix, 75001 Paris', auctionDateIso: '2026-07-07T14:00:00' }
    const result = dedupeRegionAuctions([
      auction({ ...sale, platform: 'fr-licitor', externalId: '1', title: 'Lot 1' }),
      auction({ ...sale, platform: 'fr-licitor', externalId: '2', title: 'Lot 2' }),
      auction({ ...sale, platform: 'fr-avoventes', externalId: '9' }),
    ])

    expect(ids(result)).toEqual(['fr-licitor:1', 'fr-licitor:2'])
  })
})
