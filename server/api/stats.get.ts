import { ensureEnabledCountriesLoaded, listCountries, listRegions } from '../crawlers/registry'
import { readMergedListCache } from '../utils/list-cache'

export interface SiteStats {
  countryCount: number
  regionCount: number
  totalCount: number
  activeCount: number
  fetchedAt: string | null
}

// Lightweight landing-page stats — reads the same disk cache /api/auctions
// serves from, but returns only counts instead of the full auction payload
// (which can be tens of thousands of records for the all-countries scope).
export default defineEventHandler(async (event): Promise<SiteStats> => {
  setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
  await ensureEnabledCountriesLoaded()
  const merged = await readMergedListCache()
  const auctions = merged?.auctions ?? []
  const cancelled = auctions.filter((a) => a.cancelled).length

  return {
    countryCount: listCountries().length,
    regionCount: listRegions().length,
    totalCount: auctions.length,
    activeCount: auctions.length - cancelled,
    fetchedAt: merged?.fetchedAt ?? null,
  }
})
