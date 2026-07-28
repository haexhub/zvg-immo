// Manually triggers server/tasks/enrich.ts (crawl/archive + photo/document
// pipeline) scoped to one country from /settings, then fires the reprocess
// task (extraction) for the same country — the one-button, non-destructive
// counterpart to rebuild.post.ts, which wipes and re-crawls. Together these
// run the same incremental passes the scheduled crons would, without waiting
// for either.
//
// Both go through the task wrapper (runTask, not runEnrich()/runReprocess()
// directly) so recordTaskRunStart/End still fire and the existing overlap
// guards still apply — the live task status /settings polls (see
// server/utils/task-runs.ts) would otherwise never show this click as
// 'running', and a manual click could race an in-flight scheduled run. If
// the corresponding global cron is already running, runTask's own dedup
// (see nitropack's runTask) makes this call resolve to that in-flight run's
// (whole-fleet) result instead of starting a country-scoped one — existing,
// accepted single-flight behavior, now visible via the live status instead
// of silently ignored. The reprocess call is fire-and-forget (same pattern
// as server/plugins/reprocess-bootstrap.ts) — its result isn't needed here.

import type { runEnrich } from '~/server/tasks/enrich'
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

  const outcome = (await runTask('enrich', { payload: { country } })) as Awaited<ReturnType<typeof runEnrich>>
  void runTask('reprocess', { payload: { country } }).catch((err: unknown) => {
    console.error('[settings/enrich] reprocess trigger failed:', (err as Error).message)
  })
  return outcome
})
