// Manually requests an OSM reimport for one country from /settings. The
// actual osm2pgsql work happens outside this app (host-level systemd job,
// see server/utils/osm-import-requests.ts's header) — this just records the
// request for that job's next daily run to pick up and act on immediately
// instead of waiting for it to notice missing data on its own.

import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'
import { requestOsmImport } from '~/server/utils/osm-import-requests'

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  await ensureEnabledCountriesLoaded()
  const registered = listRegisteredCountries().find((candidate) => candidate.code === country)
  if (!registered) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Datenbank nicht verfügbar.' })
  await requestOsmImport(db, country)
  return { requested: true }
})
