// Starts one country's missing translations and retries its stale pending
// claims. The status view exposes every current non-passthrough target
// language, so this is a real backlog trigger rather than only a repair for
// rows that visitors had already caused to be created. Same detached shape as
// the crawl/LLM country-wide triggers; retryTranslationsBulk itself bounds
// concurrency (see server/utils/translation-retry.ts).

import { getPool } from '~/server/utils/db'
import { readTranslationStatusIdentities } from '~/server/utils/translation-status'
import { MAX_BULK_TRANSLATION_RETRIES, retryTranslationsBulk } from '~/server/utils/translation-retry'
import { parseTargetLang } from '~/server/utils/target-lang'

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })
  const body = await readBody<{ lang?: unknown }>(event)
  const lang = parseTargetLang(body?.lang)

  const items = await readTranslationStatusIdentities(country, 'open', lang)
  const selected = items.slice(0, MAX_BULK_TRANSLATION_RETRIES)
  if (selected.length === 0) return { started: false, selected: 0, remaining: 0 }

  void retryTranslationsBulk(db, selected).catch((err: unknown) => {
    console.error('[settings/translation-retry-open] trigger failed:', (err as Error).message)
  })
  console.info(`[translation-retry-bulk] bucket=open country=${country} lang=${lang ?? 'all'} selected=${selected.length} remaining=${items.length - selected.length}`)
  return { started: true, selected: selected.length, remaining: items.length - selected.length }
})
