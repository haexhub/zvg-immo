// Starts one country's missing translations and retries its stale pending
// claims. The status view exposes every current non-passthrough target
// language, so this is a real backlog trigger rather than only a repair for
// rows that visitors had already caused to be created. Same detached shape as
// the crawl/LLM country-wide triggers; retryTranslationsBulk itself bounds
// concurrency (see server/utils/translation-retry.ts).

import { getPool } from '~/server/utils/db'
import { readTranslationStatusIdentities } from '~/server/utils/translation-status'
import { retryTranslationsBulk } from '~/server/utils/translation-retry'
import { CONTENT_TARGET_LANGS, type ContentTargetLang } from '~/lib/content-language'

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })
  const body = await readBody<{ lang?: unknown }>(event)
  const lang = typeof body?.lang === 'string' ? body.lang : ''
  if (lang && !CONTENT_TARGET_LANGS.includes(lang as ContentTargetLang)) {
    throw createError({ statusCode: 400, statusMessage: 'lang muss de oder en sein.' })
  }

  const items = await readTranslationStatusIdentities(country, 'open', (lang || undefined) as ContentTargetLang | undefined)
  if (items.length === 0) return { started: false }

  void retryTranslationsBulk(db, items).catch((err: unknown) => {
    console.error('[settings/translation-retry-open] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
