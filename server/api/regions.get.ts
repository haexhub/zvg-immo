import { ensureEnabledCountriesLoaded, listCountries, type CountryEntry } from '../crawlers/registry'

export default defineEventHandler(async (): Promise<CountryEntry[]> => {
  await ensureEnabledCountriesLoaded()
  return listCountries()
})
