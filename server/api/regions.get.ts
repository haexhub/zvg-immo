import { ALL_SCOPE } from '~/lib/auction-constants'
import { ensureEnabledCountriesLoaded, listCountries, type CountryEntry } from '../crawlers/registry'

/**
 * A nationwide-only platform registers a single region with code ALL_SCOPE,
 * named after the country itself (see PlatformCrawler.regions) — that entry
 * exists so the scheduler has something to crawl, not as something a user
 * could filter by. Offering it in the search/landing region picker gives a
 * choice that cannot narrow anything down and, because such crawlers leave
 * Auction.region empty, resolves to a `country:regionName` key that matches
 * no row at all (live: all 62 Bulgarian auctions). Countries left without any
 * region are still listed — they stay selectable by country, and the picker
 * hides its region block when the list is empty.
 */
function withoutWholeCountryRegions(countries: CountryEntry[]): CountryEntry[] {
  return countries.map((country) => ({
    ...country,
    regions: country.regions.filter((region) => region.code !== ALL_SCOPE),
  }))
}

export default defineEventHandler(async (event): Promise<CountryEntry[]> => {
  setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
  await ensureEnabledCountriesLoaded()
  return withoutWholeCountryRegions(listCountries())
})
