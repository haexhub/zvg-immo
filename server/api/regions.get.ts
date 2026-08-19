import { ensureEnabledCountriesLoaded, listCountries, type CountryEntry } from '../crawlers/registry'
import { applyPickerRegions, isNationwideOnlyCountry, readStoredRegionNames } from '../utils/region-picker'

export default defineEventHandler(async (event): Promise<CountryEntry[]> => {
  setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
  await ensureEnabledCountriesLoaded()
  const countries = listCountries()
  const nationwideOnly = countries.filter(isNationwideOnlyCountry).map((country) => country.code)
  let stored = new Map<string, string[]>()
  try {
    stored = await readStoredRegionNames(nationwideOnly)
  } catch (err) {
    // A picker without the nationwide countries' regions is still a usable
    // picker; a 500 here would take the whole search filter bar down.
    console.warn(`[regions] stored region names unavailable: ${(err as Error).message}`)
  }
  return applyPickerRegions(countries, stored)
})
