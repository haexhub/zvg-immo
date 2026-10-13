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

  it('keeps an enriched court when the list crawl leaves authority empty', () => {
    const merged = mergeStoredAuction(auction({ authority: '' }), auction({ authority: 'Sąd Rejonowy w Zgorzelcu' }))
    expect(merged.authority).toBe('Sąd Rejonowy w Zgorzelcu')
  })

  it('does not restore mutable current bids', () => {
    expect(mergeStoredAuction(auction(), auction({ currentBid: 90_000 })).currentBid).toBeUndefined()
  })

  it('keeps a longer fetched description when the list text is its prefix', () => {
    const previous = auction({
      description: 'Kurzer Text mit zusätzlichen Details',
      detailFetchedAt: '2026-08-01T10:00:00.000Z',
    })

    expect(mergeStoredAuction(auction({ description: 'Kurzer Text' }), previous).description)
      .toBe('Kurzer Text mit zusätzlichen Details')
    expect(previous.description).toBe('Kurzer Text mit zusätzlichen Details')
  })

  it('keeps the new list description before details were fetched', () => {
    const merged = mergeStoredAuction(
      auction({ description: 'Kurzer Text' }),
      auction({ description: 'Kurzer Text mit zusätzlichen Details', detailFetchedAt: null }),
    )

    expect(merged.description).toBe('Kurzer Text')
  })

  it('keeps the fetched detail address and its coordinates over a coarse list address', () => {
    const previous = auction({
      address: 'Musterstr. 5, 28277 Bremen', lat: 53.05, lng: 8.83,
      detailFetchedAt: '2026-08-01T10:00:00.000Z',
    })
    const merged = mergeStoredAuction(auction({ address: '28277 Bremen', lat: 53.03, lng: 8.86 }), previous)

    expect(merged.address).toBe('Musterstr. 5, 28277 Bremen')
    expect([merged.lat, merged.lng]).toEqual([53.05, 8.83])
  })

  it('restores neither the stored address nor its pin when the source withholds the location', () => {
    const previous = auction({
      address: 'Musterstr. 5, 28277 Bremen', lat: 53.05, lng: 8.83,
      detailFetchedAt: '2026-08-01T10:00:00.000Z',
    })
    const merged = mergeStoredAuction(
      auction({ address: null, lat: null, lng: null, coordinatesWithheld: true }),
      previous,
    )

    expect(merged.address).toBeNull()
    expect([merged.lat, merged.lng]).toEqual([null, null])
  })

  it('keeps the list address and coordinates before details were fetched', () => {
    const merged = mergeStoredAuction(
      auction({ address: '28277 Bremen', lat: 53.03, lng: 8.86 }),
      auction({ address: 'Alte Adresse', lat: 53.05, lng: 8.83, detailFetchedAt: null }),
    )

    expect(merged.address).toBe('28277 Bremen')
    expect([merged.lat, merged.lng]).toEqual([53.03, 8.86])
  })
  it('keeps the stored EUR conversion when the same foreign amount could not be converted', () => {
    const previous = auction({ marketValue: 1_000_000, currency: 'SEK', marketValueEur: 87_000 })
    const unconverted = () => auction({ marketValue: 1_000_000, currency: 'SEK', marketValueEur: null })

    expect(mergeStoredAuction(unconverted(), previous).marketValueEur).toBe(87_000)
    expect(mergeStoredAuction(auction({ marketValue: 2_000_000, currency: 'SEK' }), previous).marketValueEur).toBeNull()
  })
})
