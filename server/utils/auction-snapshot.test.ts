import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { mergePreservedDetail, normalizeLegacyAuction } from './auction-snapshot'

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

describe('normalizeLegacyAuction — pre-WP-1 snapshot field names', () => {
  it('maps every renamed field to its new name and drops the old key', () => {
    const legacy: Record<string, unknown> = {
      platform: 'zvg-portal',
      zvgId: '99',
      aktenzeichen: '1 K 5/25',
      amtsgericht: 'AG Musterstadt',
      objekt: 'Reihenhaus',
      adresse: 'Musterweg 1',
      verkehrswertEur: 250000,
      verkehrswertText: '250.000 €',
      terminIso: '2026-08-01T09:00:00.000Z',
      terminText: '01.08.2026 09:00',
      aufgehoben: false,
      letzteAktualisierungIso: '2026-07-01T00:00:00.000Z',
      beschreibung: 'Alte Beschreibung',
      fotoCount: 3,
      detailFetchedAt: '2026-07-01T00:00:00.000Z',
    }
    normalizeLegacyAuction(legacy)

    expect(legacy.externalId).toBe('99')
    expect(legacy.caseNumber).toBe('1 K 5/25')
    expect(legacy.authority).toBe('AG Musterstadt')
    expect(legacy.title).toBe('Reihenhaus')
    expect(legacy.address).toBe('Musterweg 1')
    expect(legacy.marketValueEur).toBe(250000)
    expect(legacy.marketValueText).toBe('250.000 €')
    expect(legacy.auctionDateIso).toBe('2026-08-01T09:00:00.000Z')
    expect(legacy.auctionDateText).toBe('01.08.2026 09:00')
    expect(legacy.cancelled).toBe(false)
    expect(legacy.sourceUpdatedIso).toBe('2026-07-01T00:00:00.000Z')
    expect(legacy.description).toBe('Alte Beschreibung')
    expect(legacy.photoCount).toBe(3)
    // detailFetchedAt is preserved (unchanged name), which is exactly why the
    // renamed fields must be mapped: it suppresses re-enrichment.
    expect(legacy.detailFetchedAt).toBe('2026-07-01T00:00:00.000Z')

    for (const oldKey of [
      'zvgId', 'aktenzeichen', 'amtsgericht', 'objekt', 'adresse',
      'verkehrswertEur', 'verkehrswertText', 'terminIso', 'terminText',
      'aufgehoben', 'letzteAktualisierungIso', 'beschreibung', 'fotoCount',
    ]) {
      expect(legacy[oldKey]).toBeUndefined()
    }
  })

  it('leaves an already-migrated entry untouched (no-op after re-crawl)', () => {
    const current: Record<string, unknown> = { externalId: '7', description: 'Neu', photoCount: 2 }
    normalizeLegacyAuction(current)
    expect(current).toEqual({ externalId: '7', description: 'Neu', photoCount: 2 })
  })

  it('does not clobber a present new value with a stale legacy one', () => {
    const mixed: Record<string, unknown> = { description: 'Neu', beschreibung: 'Alt' }
    normalizeLegacyAuction(mixed)
    expect(mixed.description).toBe('Neu')
  })
})
