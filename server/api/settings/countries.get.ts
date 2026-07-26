import { ensureEnabledCountriesLoaded } from '~/server/crawlers/registry'
import {
  countrySourceSettings,
  type CountrySourceSettings,
} from '~/server/utils/country-source-settings'

export default defineEventHandler(async (): Promise<CountrySourceSettings> => {
  await ensureEnabledCountriesLoaded()
  return countrySourceSettings()
})
