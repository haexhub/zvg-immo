// Manually retries one country's failed translation rows right away, without
// waiting for someone to reload the auction in that language (which is what
// re-triggers a 'failed' row's 1h backoff normally — see the public
// translation.post.ts). Same detached shape as translation-retry-open.post.ts,
// just for the 'error' bucket.

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

  const items = await readTranslationStatusIdentities(country, 'error')
  if (items.length === 0) return { started: false }

  void retryTranslationsBulk(db, items).catch((err: unknown) => {
    console.error('[settings/translation-retry-failed] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
