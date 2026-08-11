// Manually retries one country's stuck-pending translation rows (claimed but
// never resolved — e.g. a container restart mid-attempt, see
// translation-status.ts's 'open' bucket) right away. Translation has no
// proactive backlog to grow (a row only exists once a visitor viewed an
// auction in another language), so unlike enrich/reprocess this only ever
// touches rows that already exist. Same detached shape as the crawl/LLM
// country-wide triggers; retryTranslationsBulk itself bounds concurrency
// (see server/utils/translation-retry.ts).

import { getPool } from '~/server/utils/db'
import { readTranslationStatusIdentities } from '~/server/utils/translation-status'
import { retryTranslationsBulk } from '~/server/utils/translation-retry'

export default defineEventHandler(async (event) => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })

  const items = await readTranslationStatusIdentities(country, 'open')
  if (items.length === 0) return { started: false }

  void retryTranslationsBulk(db, items).catch((err: unknown) => {
    console.error('[settings/translation-retry-open] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
