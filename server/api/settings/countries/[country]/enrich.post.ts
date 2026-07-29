// Manually refreshes one country from /settings: force-crawl the source once,
// write list_cache + raw auction captures, run the full enrich archive/document
// pipeline, then fire reprocess (rules + LLM) against the raw archive.
//
// Every long-running phase goes through its task wrapper so /settings can poll
// status and a newer run can supersede an older one. The request stays
// attached until all phases finish so no failure disappears in the background.

import type { runEnrich } from '~/server/tasks/enrich'
import type { ReprocessResult } from '~/server/tasks/reprocess'
import type { ExternalEnrichmentSummary } from '~/server/tasks/external-enrichment'
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
  // Keep every phase attached to the admin request: failures are returned to
  // the frontend instead of disappearing in a detached promise. Each task
  // wrapper is exclusive and supersedes an older run of the same task.
  const [reprocessOutcome, externalOutcome] = await Promise.all([
    runTask('reprocess', { payload: { country, force: forceExtraction } }) as Promise<{ result: ReprocessResult }>,
    runTask('external-enrichment', { payload: { country } }) as Promise<{ result: ExternalEnrichmentSummary }>,
  ])
  return {
    ...outcome,
    result: outcome?.result
      ? {
          ...outcome.result,
          warning: outcome.warning ?? null,
          reprocess: reprocessOutcome.result,
          externalEnrichment: externalOutcome.result,
        }
      : outcome?.result,
  }
})
