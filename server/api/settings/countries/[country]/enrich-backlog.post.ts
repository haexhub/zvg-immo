// Manually re-archives one country's still-open crawl backlog (never
// successfully detail-fetched, and no recorded task_run_errors row either —
// see crawl-status.ts's 'open' bucket) right away instead of waiting for the
// next enrich cron tick, without paying for a full live region re-crawl (see
// enrich-worker.ts's `identities` scoping). Same detached shape as
// reprocess-backlog.post.ts, just for the crawl/archive side.

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

  const identities = await readCrawlStatusIdentities(country, 'open')
  if (identities.length === 0) return { started: false }

  // Detached on purpose — see the file header. A rejection here is still
  // recorded as the task's lastError by its own defineTask wrapper; the catch
  // only keeps the trigger itself from becoming an unhandled rejection.
  void runTask('enrich', { payload: { country, identities, trigger: 'manual' } }).catch((err: unknown) => {
    console.error('[settings/enrich-backlog] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
