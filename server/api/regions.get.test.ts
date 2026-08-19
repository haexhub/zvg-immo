import { describe, expect, it } from 'vitest'
import { ALL_SCOPE } from '~/lib/auction-constants'
import { listCountries, listRegisteredCountries } from '../crawlers/registry'

/** Mirrors regions.get.ts. Kept as a data assertion rather than a handler
 *  invocation so it needs no h3 event: the endpoint is a thin wrapper around
 *  listCountries() plus this projection. */
function withoutWholeCountryRegions<T extends { regions: Array<{ code: string }> }>(countries: T[]): T[] {
  return countries.map((country) => ({
    ...country,
    regions: country.regions.filter((region) => region.code !== ALL_SCOPE),
  }))
}

describe('/api/regions region projection', () => {
  it('drops the whole-country pseudo-region a nationwide-only platform registers', () => {
    const served = withoutWholeCountryRegions(listRegisteredCountries())

    expect(served.flatMap((c) => c.regions).some((r) => r.code === ALL_SCOPE)).toBe(false)
    // Bulgaria's sole region entry is exactly such a pseudo-region — it stays
    // selectable as a country, it just no longer offers a region that could
    // never match a row (its auctions carry an empty Auction.region).
    const bg = served.find((c) => c.code === 'bg')
    expect(bg?.regions).toEqual([])
  })

  it('keeps real sub-regions, including a country covered by a single real one', () => {
    const served = withoutWholeCountryRegions(listRegisteredCountries())

    // Canada is served for Ontario only, but 'on' is a genuine province code
    // that the crawler also writes to Auction.region, so it must survive.
    expect(served.find((c) => c.code === 'ca')?.regions.map((r) => r.name)).toEqual(['Ontario'])
    expect(served.find((c) => c.code === 'de')?.regions.map((r) => r.name)).toContain('Sachsen')
    expect(served.find((c) => c.code === 'se')?.regions.map((r) => r.name)).toContain('Stockholm')
  })

  it('leaves the registry itself untouched — the projection is API-only', () => {
    // listRegions()/listCountries() drive crawl scheduling and the admin
    // catalog, where the "all" entry is what tells the scheduler to crawl a
    // nationwide-only platform at all. Only the search/landing payload drops it.
    expect(listRegisteredCountries().flatMap((c) => c.regions).some((r) => r.code === ALL_SCOPE)).toBe(true)
    // Germany has no such entry to begin with: every platform serving it,
    // BImA included, registers real Bundesländer.
    expect(listCountries().find((c) => c.code === 'de')?.regions.some((r) => r.code === ALL_SCOPE)).toBe(false)
  })
})
