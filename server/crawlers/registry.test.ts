import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { frAddressDateKey } from './registry'

function auction(overrides: Partial<Auction>): Auction {
  return {
    platform: 'fr-licitor',
    country: 'fr',
    region: '',
    zvgId: 'x',
    aktenzeichen: '',
    amtsgericht: '',
    objekt: null,
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

describe('frAddressDateKey', () => {
  it('builds a {postal, houseNumber, date} fingerprint for a normal street address', () => {
    expect(
      frAddressDateKey(
        auction({ adresse: "129 Bd d'Aulnay, 93250 Villemomble", terminIso: '2026-07-07T14:00:00' }),
      ),
    ).toBe('fr-addr|93250|129|2026-07-07')
  })

  it('keeps a letter-suffixed house number (e.g. "5B")', () => {
    expect(
      frAddressDateKey(
        auction({ adresse: '5B Chem. de Thenières, 74140 Massongy', terminIso: '2026-08-28T15:00:00' }),
      ),
    ).toBe('fr-addr|74140|5B|2026-08-28')
  })

  it('returns null for a postal-code-only address with no house number, instead of using the postal code as one', () => {
    expect(frAddressDateKey(auction({ adresse: '56930 Pluméliau-Bieuzy', terminIso: '2026-07-06T10:30:00' }))).toBeNull()
  })

  it('returns null when country is not fr', () => {
    expect(
      frAddressDateKey(
        auction({ country: 'at', adresse: '12 Rue de la Paix, 75001 Paris', terminIso: '2026-07-07T14:00:00' }),
      ),
    ).toBeNull()
  })

  it('returns null when adresse or terminIso is missing', () => {
    expect(frAddressDateKey(auction({ adresse: null, terminIso: '2026-07-07T14:00:00' }))).toBeNull()
    expect(frAddressDateKey(auction({ adresse: '12 Rue de la Paix, 75001 Paris', terminIso: null }))).toBeNull()
  })
})
