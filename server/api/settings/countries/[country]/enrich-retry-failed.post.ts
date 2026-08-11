// Manually retries one country's failed crawl candidates (never successfully
// detail-fetched, with a recorded task_run_errors row — see crawl-status.ts's
// 'error' bucket) right away, without paying for a full live region re-crawl
// (see enrich-worker.ts's `identities` scoping). Same detached shape as
// reprocess-retry-failed.post.ts, just for the crawl/archive side.

import { readCrawlStatusIdentities } from '~/server/utils/crawl-status'
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

  const identities = await readCrawlStatusIdentities(country, 'error')
  if (identities.length === 0) return { started: false }

  void runTask('enrich', { payload: { country, identities } }).catch((err: unknown) => {
    console.error('[settings/enrich-retry-failed] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
