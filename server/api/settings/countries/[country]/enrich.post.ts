// Manually refreshes one country from /settings: force-crawl the source once,
// record the crawl scope + raw auction captures, run the full enrich archive/document
// pipeline, then fire reprocess (rules + LLM) against the raw archive.
//
// Every long-running phase goes through its task wrapper so /settings can poll
// status (enrich queues behind an active run; reprocess and external
// enrichment let a newer run supersede an older one). The whole chain is
// detached: a country-wide crawl alone can take far longer than the reverse
// proxy keeps a request open, so the request only validates and answers
// {started:true}. Reprocess and external enrichment are chained via .then so
// they only start once the crawl/archive phase has finished. Failures are not
// lost: every phase records its outcome via server/utils/task-runs.ts, which
// /settings polls and renders next to this button (enrichStatus /
// reprocessStatus / externalEnrichmentStatus).

import { runReprocessTask } from '~/server/tasks/reprocess'
import { runEnrichTask } from '~/server/tasks/enrich'
import { runExternalEnrichmentTask } from '~/server/tasks/external-enrichment'
import { ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '~/server/crawlers/registry'

interface EnrichCountryBody {
  forceExtraction?: boolean
  /** Set by the dashboard's crawler action when LLM extraction is started separately. */
  runExtraction?: boolean
}

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  const body = await readBody<EnrichCountryBody>(event).catch(() => undefined) ?? ({} as EnrichCountryBody)
  const forceExtraction = body.forceExtraction === true
  const runExtraction = body.runExtraction !== false
  await ensureEnabledCountriesLoaded()
  const registered = listRegisteredCountries().find((candidate) => candidate.code === country)
  if (!registered) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  if (!isCountryEnabled(country)) {
    throw createError({ statusCode: 400, statusMessage: `${registered.name} ist deaktiviert.` })
  }

  // Detached on purpose — see the file header. A rejection is still recorded
  // as the failing task's lastError by its own wrapper; the catches only keep
  // the triggers from becoming unhandled rejections.
  void runEnrichTask({ country, force: true, recordCrawlScope: true, trigger: 'manual' })
    .then(() => {
      if (runExtraction) {
        void runReprocessTask({ country, force: forceExtraction, trigger: 'manual' }).catch((err: unknown) => {
          console.error('[settings/enrich] reprocess trigger failed:', (err as Error).message)
        })
      }
      void runExternalEnrichmentTask({ country, trigger: 'manual' }).catch((err: unknown) => {
        console.error('[settings/enrich] external enrichment trigger failed:', (err as Error).message)
      })
    })
    .catch((err: unknown) => {
      console.error('[settings/enrich] enrich trigger failed:', (err as Error).message)
    })
  return { started: true as const }
})
