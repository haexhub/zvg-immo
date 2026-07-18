import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { completenessScore, frAddressDateKey } from './registry'

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
