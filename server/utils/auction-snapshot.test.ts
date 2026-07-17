import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { mergePreservedDetail } from './auction-snapshot'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'all',
    zvgId: '42',
    aktenzeichen: '1 K 1/26',
    amtsgericht: '',
    objekt: 'Einfamilienhaus',
    adresse: null,
    verkehrswertEur: null,
    verkehrswertText: null,
    terminIso: null,
    terminText: null,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    beschreibung: null,
    fotoCount: 0,
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

describe('mergePreservedDetail — photoUrls and fotoCount', () => {
  it('restores the gallery and keeps fotoCount consistent with it', () => {
    const next = mergePreservedDetail(
      auction({ fotoCount: 1, thumbnailUrl: 'https://x/1.jpg' }),
      auction({ fotoCount: 5, photoUrls: ['a', 'b', 'c', 'd', 'e'] }),
    )
    expect(next.photoUrls).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(next.fotoCount).toBe(5)
  })

  it('does not lower a higher fresh fotoCount when restoring photoUrls', () => {
    const next = mergePreservedDetail(
      auction({ fotoCount: 7 }),
      auction({ photoUrls: ['a', 'b'] }),
    )
    expect(next.photoUrls).toEqual(['a', 'b'])
    expect(next.fotoCount).toBe(7)
  })

  it('keeps a fresh non-empty gallery', () => {
    const next = mergePreservedDetail(
      auction({ photoUrls: ['new'], fotoCount: 1 }),
      auction({ photoUrls: ['old1', 'old2'], fotoCount: 2 }),
    )
    expect(next.photoUrls).toEqual(['new'])
    expect(next.fotoCount).toBe(1)
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

describe('mergePreservedDetail — aktenzeichen', () => {
  it('restores a previously known aktenzeichen when the re-crawl lost it', () => {
    expect(mergePreservedDetail(auction({ aktenzeichen: '' }), auction()).aktenzeichen).toBe(
      '1 K 1/26',
    )
  })

  it('keeps a fresh aktenzeichen', () => {
    const next = mergePreservedDetail(auction({ aktenzeichen: '2 K 9/26' }), auction())
    expect(next.aktenzeichen).toBe('2 K 9/26')
  })
})

describe('mergePreservedDetail — beschreibung', () => {
  it('restores the beschreibung when the fresh crawl has none', () => {
    const next = mergePreservedDetail(auction(), auction({ beschreibung: 'Alt' }))
    expect(next.beschreibung).toBe('Alt')
  })

  it('keeps the enriched extension when it starts with the fresh list text', () => {
    const next = mergePreservedDetail(
      auction({ beschreibung: 'Listentext.' }),
      auction({
        beschreibung: 'Listentext.\nKadastra apzīmējums: 0100 012 0345',
        detailFetchedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    expect(next.beschreibung).toBe('Listentext.\nKadastra apzīmējums: 0100 012 0345')
  })

  it('does not restore an extension the detail fetch never produced', () => {
    // prev longer but never detail-fetched → could be stale list text; keep next.
    const next = mergePreservedDetail(
      auction({ beschreibung: 'Listentext.' }),
      auction({ beschreibung: 'Listentext.\nMehr' }),
    )
    expect(next.beschreibung).toBe('Listentext.')
  })

  it('keeps a genuinely changed fresh beschreibung', () => {
    const next = mergePreservedDetail(
      auction({ beschreibung: 'Neuer Text' }),
      auction({
        beschreibung: 'Alter Text mit Anhang',
        detailFetchedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    expect(next.beschreibung).toBe('Neuer Text')
  })
})
