// Manually retries one country's failed translation rows right away, without
// waiting for someone to reload the auction in that language (which is what
// re-triggers a 'failed' row's 1h backoff normally — see the public
// translation.post.ts). Same detached shape as translation-retry-open.post.ts,
// just for the 'error' bucket.

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

  const items = await readTranslationStatusIdentities(country, 'error', lang)
  const selected = items.slice(0, MAX_BULK_TRANSLATION_RETRIES)
  if (selected.length === 0) return { started: false, selected: 0, remaining: 0 }

  void retryTranslationsBulk(db, selected).catch((err: unknown) => {
    console.error('[settings/translation-retry-failed] trigger failed:', (err as Error).message)
  })
  console.info(`[translation-retry-bulk] bucket=error country=${country} lang=${lang ?? 'all'} selected=${selected.length} remaining=${items.length - selected.length}`)
  return { started: true, selected: selected.length, remaining: items.length - selected.length }
})
