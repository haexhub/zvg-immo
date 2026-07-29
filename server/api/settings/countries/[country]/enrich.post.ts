// Manually refreshes one country from /settings: force-crawl the source once,
// write list_cache + raw auction captures, run the full enrich archive/document
// pipeline, then fire reprocess (rules + LLM) against the raw archive.
//
// The long-running crawl/extract phases still go through the task wrapper so
// /settings can poll their status via server/utils/task-runs.ts. Reprocess is
// fire-and-forget (same pattern as server/plugins/reprocess-bootstrap.ts): the
// button returns after the raw archive has been rebuilt, while LLM extraction
// progress remains visible in the existing status panel.

import type { runEnrich } from '~/server/tasks/enrich'
import { ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '~/server/crawlers/registry'

interface EnrichCountryBody {
  forceExtraction?: boolean
}

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  const body = await readBody<EnrichCountryBody>(event).catch((): EnrichCountryBody => ({}))
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
  void runTask('reprocess', { payload: { country, force: forceExtraction } }).catch((err: unknown) => {
    console.error('[settings/enrich] reprocess trigger failed:', (err as Error).message)
  })
  void runTask('external-enrichment', { payload: { country } }).catch((err: unknown) => {
    console.error('[settings/enrich] external enrichment trigger failed:', (err as Error).message)
  })
  return outcome
})
