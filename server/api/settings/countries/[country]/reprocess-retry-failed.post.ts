// Manually retries one country's locked-out LLM candidates (llm_failures >=
// MAX_LLM_FAILURES) right away instead of waiting for the automatic 24h
// cooldown (see LLM_FAILURE_RETRY_COOLDOWN_HOURS in lib/llm-limits.ts).
// Unlike force (which would also re-spend the LLM budget on every
// already-successful auction in the country), ignoreCooldown only bypasses
// the cooldown gate — a candidate still has to actually need an attempt
// (see reprocess-run.ts's eligibility check). Same detached shape as
// reprocess-backlog.post.ts, just for the 'error' bucket instead of 'open'.

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

  void runTask('reprocess', { payload: { country, force: false, ignoreCooldown: true, trigger: 'manual' } }).catch((err: unknown) => {
    console.error('[settings/reprocess-retry-failed] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
