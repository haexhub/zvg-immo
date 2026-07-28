import { ensureEnabledCountriesLoaded, listCountries, type CountryEntry } from '../crawlers/registry'

export default defineEventHandler(async (event): Promise<CountryEntry[]> => {
  setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
  await ensureEnabledCountriesLoaded()
  return listCountries()
})
