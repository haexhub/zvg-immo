import {
  configureEnabledCountries,
  listRegisteredCountries,
} from '~/server/crawlers/registry'
import { getPool } from '~/server/utils/db'
import { setEnabledCountries as setStoredEnabledCountries } from '~/server/utils/app-settings'
import {
  countrySourceSettings,
  type CountrySourceSettings,
} from '~/server/utils/country-source-settings'

export default defineEventHandler(async (event): Promise<CountrySourceSettings> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }

  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)
  if (
    !Array.isArray(body.enabledCountries)
    || !body.enabledCountries.every((country) => typeof country === 'string')
  ) {
    throw createError({ statusCode: 400, statusMessage: 'enabledCountries: ungültiger Wert.' })
  }

  const enabledCountries = [
    ...new Set(body.enabledCountries.map((country) => country.trim().toLowerCase())),
  ]
  const registered = new Set(listRegisteredCountries().map((country) => country.code))
  const unknown = enabledCountries.filter((country) => !registered.has(country))
  if (unknown.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unbekannte Länderquelle: ${unknown.join(', ')}`,
    })
  }

  await setStoredEnabledCountries(db, enabledCountries)
  configureEnabledCountries(enabledCountries)
  return countrySourceSettings()
})
