import { afterEach, describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { DEFAULT_ENABLED_COUNTRIES } from '~/server/utils/app-settings'
import { ALL_SCOPE } from '~/lib/auction-constants'
import {
  completenessScore,
  configureEnabledCountries,
  frAddressDateKey,
  getCrawlersForRegion,
  isCountryEnabled,
  listCountries,
  listRegisteredCountries,
  platforms,
} from './registry'

afterEach(() => {
  configureEnabledCountries(DEFAULT_ENABLED_COUNTRIES)
})

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

describe('enabled countries', () => {
  it('surfaces Germany and Sweden for crawling and country discovery', () => {
    expect(listCountries().map((country) => country.code)).toEqual(['de', 'se'])
    expect(isCountryEnabled('DE')).toBe(true)
    expect(isCountryEnabled('SE')).toBe(true)
  })

  it('dispatches Sweden to the Kronofogden crawler', () => {
    expect(getCrawlersForRegion('se', 'all').map((crawler) => crawler.id)).toEqual([
      'se-kronofogden',
    ])
  })

  it('keeps countries outside the current rollout paused', () => {
    expect(isCountryEnabled('at')).toBe(false)
    expect(getCrawlersForRegion('at', 'all')).toEqual([])
  })

  it('applies an admin selection without hiding paused sources from the admin catalog', () => {
    configureEnabledCountries(['se'])

    expect(listCountries().map((country) => country.code)).toEqual(['se'])
    expect(isCountryEnabled('de')).toBe(false)
    expect(listRegisteredCountries().map((country) => country.code)).toContain('de')
  })

  it('ignores country codes without a registered crawler', () => {
    expect(configureEnabledCountries(['se', 'xx'])).toEqual(['se'])
    expect(isCountryEnabled('xx')).toBe(false)
  })
})

describe('registered region codes', () => {
  // getCrawlersForRegion() reads ALL_SCOPE as "every platform of this
  // country", so a country must not mix that literal code with real
  // sub-region codes: the scheduler's pass over the "all" entry would
  // re-crawl every sibling portal in full on top of their own per-region
  // passes. Countries where every platform is nationwide-only (fr, gb, bg,
  // us) are fine — there "all" is the country's only region entry, so it is
  // crawled exactly once.
  it('never mixes the ALL scope with real sub-region codes inside one country', () => {
    const codesPerCountry = new Map<string, Set<string>>()
    for (const platform of platforms) {
      const codes = codesPerCountry.get(platform.country) ?? new Set<string>()
      for (const region of platform.regions) codes.add(region.code)
      codesPerCountry.set(platform.country, codes)
    }

    const mixed = [...codesPerCountry.entries()]
      .filter(([, codes]) => codes.has(ALL_SCOPE) && codes.size > 1)
      .map(([country]) => country)

    expect(mixed).toEqual([])
  })
})
