// Manually retries one country's locked-out LLM candidates (llm_failures >=
// MAX_LLM_FAILURES) right away instead of waiting for the automatic 24h
// cooldown (see LLM_FAILURE_RETRY_COOLDOWN_HOURS in lib/llm-limits.ts).
// Unlike force (which would also re-spend the LLM budget on every
// already-successful auction in the country), ignoreCooldown/ignoreBatchPending
// only bypass their respective gates — a candidate still has to actually need
// an attempt (see reprocess-run.ts's eligibility check). failedOnly
// additionally restricts eligibility to the 'error' bucket itself, so this
// action never picks up a country's ordinary open/never-attempted candidates.
// Same detached shape as reprocess-backlog.post.ts, just for 'error' instead
// of 'open'.

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

  // An explicit retry must make an actual provider call. In batch mode a
  // failed submission only leaves the candidates in the same error bucket,
  // which is indistinguishable from a no-op in this detached UI action.
  // Batch remains available for scheduled/full reprocess runs; this action
  // deliberately uses the reliable synchronous path.
  void runReprocessTask({ country, force: false, batch: false, ignoreCooldown: true, ignoreBatchPending: true, failedOnly: true, ignoreLlmBudget: true, trigger: 'manual' }).catch((err: unknown) => {
    console.error('[settings/reprocess-retry-failed] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
