// Admin single-run with an explicitly chosen LLM profile (docs/plans/2026-08-08-
// admin-auktions-technikseite.md, WP-4). Detached like the other long-runners
// (countries/[country]/enrich.post.ts, settings/reprocess.post.ts's country-wide
// sibling) — a Gutachten extraction routinely exceeds the reverse-proxy
// timeout. The admin page has no dedicated status endpoint to poll: it re-fetches
// the technical overview and watches for a new trial version (success) or a
// new error (failure, via WP-7's task_run_errors).

import { isSafePathSegment } from '~/server/utils/path-segment'
import { validateAdminTrialReprocess, runAdminTrialReprocess } from '~/server/utils/auction-admin-trial'

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }

  const body = await readBody<{ profileId?: string }>(event).catch(() => undefined) ?? {}
  const profileId = typeof body.profileId === 'string' ? body.profileId : ''
  if (!profileId) {
    throw createError({ statusCode: 400, statusMessage: 'profileId fehlt.' })
  }

  const outcome = await validateAdminTrialReprocess(platform, id, profileId)
  if (!outcome.ok) {
    if (outcome.reason === 'unknown_profile') {
      throw createError({ statusCode: 400, statusMessage: `Unbekanntes LLM-Profil: ${profileId}` })
    }
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

  void runAdminTrialReprocess(platform, id, profileId)
  return { started: true }
})
