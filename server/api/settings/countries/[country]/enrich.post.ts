// Manually refreshes one country from /settings: force-crawl the source once,
// write list_cache + raw auction captures, run the full enrich archive/document
// pipeline, then fire reprocess (rules + LLM) against the raw archive.
//
// Every long-running phase goes through its task wrapper so /settings can poll
// status and a newer run can supersede an older one. The request awaits only
// the crawl/archive phase; reprocess and external enrichment are detached
// because a country-wide extraction run takes far longer than the reverse proxy
// keeps a request open. Their failures are not lost: both record their outcome
// via server/utils/task-runs.ts, which /settings polls and renders next to this
// button (enrichStatus / reprocessStatus / externalEnrichmentStatus).

import type { runEnrich } from '~/server/tasks/enrich'
import { ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '~/server/crawlers/registry'

interface EnrichCountryBody {
  forceExtraction?: boolean
}

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  const body = await readBody<EnrichCountryBody>(event).catch(() => undefined) ?? ({} as EnrichCountryBody)
  const forceExtraction = body.forceExtraction === true
  await ensureEnabledCountriesLoaded()
  const registered = listRegisteredCountries().find((candidate) => candidate.code === country)
  if (!registered) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  if (!isCountryEnabled(country)) {
    throw createError({ statusCode: 400, statusMessage: `${registered.name} ist deaktiviert.` })
  }

  const outcome = (await runTask('enrich', { payload: { country, force: true, writeListCache: true } })) as Awaited<ReturnType<typeof runEnrich>>
  // Detached on purpose — see the file header. A rejection here is still
  // recorded as the task's lastError by its own defineTask wrapper; the catch
  // only keeps the trigger itself from becoming an unhandled rejection.
  void runTask('reprocess', { payload: { country, force: forceExtraction } }).catch((err: unknown) => {
    console.error('[settings/enrich] reprocess trigger failed:', (err as Error).message)
  })
  void runTask('external-enrichment', { payload: { country } }).catch((err: unknown) => {
    console.error('[settings/enrich] external enrichment trigger failed:', (err as Error).message)
  })
  return {
    ...outcome,
    result: outcome?.result
      ? {
          ...outcome.result,
          warning: outcome.warning ?? null,
          followUpTasksStarted: true,
        }
      : outcome?.result,
  }
})
