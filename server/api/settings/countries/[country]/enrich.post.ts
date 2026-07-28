// Manually triggers server/tasks/enrich.ts (crawl/archive + photo/document
// pipeline, no extraction) scoped to one country from /settings — the
// non-destructive counterpart to rebuild.post.ts, which wipes and re-crawls.
// This just runs the same incremental pass the scheduled cron tick would,
// without waiting for it.

import { runEnrich } from '~/server/tasks/enrich'
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

  return await runEnrich({ country })
})
