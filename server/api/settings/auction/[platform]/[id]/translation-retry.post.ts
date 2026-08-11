// Admin single-auction translation (re)trigger for the /settings translation-
// status card. Unlike the public translation endpoint (server/api/auction/
// [platform]/[id]/translation.post.ts), this bypasses the 1h failed-attempt
// backoff entirely — an explicit admin click is exactly the "retry now"
// escape hatch that endpoint already has for a changed LLM config, just
// without requiring the config to have changed.
//
// Detached like the other single-auction admin triggers (auction-admin-
// trial.ts's runAdminTrialReprocess): a translation call can still take a
// few seconds, and /settings has no dedicated status endpoint to await —
// the translation-status card just re-polls its list. The actual retry logic
// lives in server/utils/translation-retry.ts, shared with the country-wide
// open/failed bulk retry endpoints.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { getPool } from '~/server/utils/db'
import { retryAuctionTranslation } from '~/server/utils/translation-retry'
import { SUPPORTED_TARGET_LANGS } from '~/server/api/auction/[platform]/[id]/translation.post'
import type { ContentTargetLang } from '~/lib/content-language'

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const body = await readBody<{ lang?: string }>(event).catch(() => undefined) ?? {}
  if (!SUPPORTED_TARGET_LANGS.has(body.lang as ContentTargetLang)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid or missing lang' })
  }
  const targetLang = body.lang as ContentTargetLang

  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })

  const outcome = await retryAuctionTranslation(db, platform, id, targetLang)
  if (outcome === 'not_found') throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  if (outcome === 'already_running') throw createError({ statusCode: 409, statusMessage: 'Übersetzung läuft bereits.' })
  return { started: true }
})
