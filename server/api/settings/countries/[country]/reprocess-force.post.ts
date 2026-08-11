// Starts a full, country-scoped extraction retry without waiting for the
// request to finish. A country is sufficient scope for `force: true`; unlike
// the generic /settings/reprocess endpoint this is safe for the dashboard and
// keeps the reverse proxy out of the long-running extraction path.
import { ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '~/server/crawlers/registry'

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  await ensureEnabledCountriesLoaded()
  const registered = listRegisteredCountries().find((candidate) => candidate.code === country)
  if (!registered) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  if (!isCountryEnabled(country)) {
    throw createError({ statusCode: 400, statusMessage: `${registered.name} ist deaktiviert.` })
  }

  void runTask('reprocess', { payload: { country, force: true, trigger: 'manual' } }).catch((err: unknown) => {
    console.error('[settings/reprocess-force] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
