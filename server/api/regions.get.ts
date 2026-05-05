import { listCountries, type CountryEntry } from '../crawlers/registry'

export default defineEventHandler((): CountryEntry[] => {
  return listCountries()
})
