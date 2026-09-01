// Manually kicks off server/tasks/reprocess.ts for one country's open LLM
// backlog (auctions never successfully parsed by the LLM yet, or with newly
// archived documents — see llm-batch-jobs.get.ts's backlog counters) instead
// of waiting for the next cron tick. Unlike /api/settings/reprocess.post.ts
// (a bounded, synchronous spot check for iterating on prompts), this is
// detached and unbounded — same shape as the reprocess trigger inside
// countries/[country]/enrich.post.ts, just without the crawl/archive phase
// ahead of it. force stays false, so it only ever touches genuinely open
// candidates; /settings reads progress via reprocessStatus (see
// llm-batch-jobs.get.ts), already polled by useSettingsTaskOverview.

import { ensureEnabledCountriesLoaded, isCountryEnabled, listRegisteredCountries } from '~/server/crawlers/registry'
import { runReprocessTask } from '~/server/tasks/reprocess'

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

  // Detached on purpose — see the file header. A rejection here is still
  // recorded as the task's lastError by its own defineTask wrapper; the catch
  // only keeps the trigger itself from becoming an unhandled rejection.
  // ignoreBatchPending: an admin explicitly asking to retry the open backlog
  // now shouldn't stay blocked by a stuck/failed batch job's leftover marker
  // (see LLM_BATCH_JOB_EXPIRY_MS). openOnly: without it, the default
  // eligibility also lets a locked-out candidate back in once its 24h
  // cooldown has elapsed (see cooldownElapsed in reprocess-run.ts) — correct
  // for the unattended cron, but a "Retry open" click asks for exactly the
  // open bucket and nothing else. force stays false, so this still only ever
  // touches genuinely open candidates, never 'done' or (even cooled-down)
  // locked-out ones.
  void runReprocessTask({ country, force: false, ignoreBatchPending: true, openOnly: true, trigger: 'manual' }).catch((err: unknown) => {
    console.error('[settings/reprocess-backlog] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
