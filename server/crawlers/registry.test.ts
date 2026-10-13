import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENABLED_COUNTRIES } from '~/server/utils/app-settings'
import { ALL_SCOPE } from '~/lib/auction-constants'
import {
  configureEnabledCountries,
  crawlSingle,
  getCrawlersForRegion,
  isCountryEnabled,
  listCountries,
  listRegisteredCountries,
  platforms,
} from './registry'
import { kronofogdenCrawler } from './se'

afterEach(() => {
  configureEnabledCountries(DEFAULT_ENABLED_COUNTRIES)
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

describe('crawlSingle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not record a platform as succeeded when it fulfills with an incomplete run', async () => {
    // A crawler can return normally (no throw) after a partial run — e.g. BOE
    // stopping pagination early — and signal that by leaving itself out of
    // its own platformsSucceeded. crawlSingle must trust that signal instead
    // of treating every non-throwing crawl as complete.
    vi.spyOn(kronofogdenCrawler, 'crawl').mockResolvedValue({
      platform: 'se-kronofogden',
      platformsSucceeded: [],
      source: 'https://example.test',
      countries: ['se'],
      regions: ['all'],
      fetchedAt: new Date().toISOString(),
      totalReported: 10,
      auctions: [],
    })

    const result = await crawlSingle({ country: 'se', region: 'all' })

    expect(result.platformsSucceeded).toEqual([])
  })

  it('records a platform as succeeded when it fulfills with a complete run', async () => {
    vi.spyOn(kronofogdenCrawler, 'crawl').mockResolvedValue({
      platform: 'se-kronofogden',
      platformsSucceeded: ['se-kronofogden'],
      source: 'https://example.test',
      countries: ['se'],
      regions: ['all'],
      fetchedAt: new Date().toISOString(),
      totalReported: 0,
      auctions: [],
    })

    const result = await crawlSingle({ country: 'se', region: 'all' })

    expect(result.platformsSucceeded).toEqual(['se-kronofogden'])
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
