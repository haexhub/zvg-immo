// Admin single-auction LLM (re)trigger for the /settings LLM-status card's
// per-row retry button. Unlike reprocess.post.ts (the admin technical page's
// explicit-profile trial run), this uses the normal configured LLM chain and
// needs no body — findCandidates already supports platform/externalId
// scoping (see reprocess-input.ts), and `force: true` bypasses both the
// lockout cooldown and the natural eligibility check, same as the country-
// wide reprocess-retry-failed.post.ts just narrowed to one auction.
//
// Detached like the other single-auction admin triggers (translation-retry,
// enrich-retry): a reprocess run's LLM call can take a while, and /settings
// has no dedicated status endpoint to await — the LLM-status card just
// re-polls its list.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { readAuctionRecord } from '~/server/utils/auction-record'

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }

  const record = await readAuctionRecord(platform, id)
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

  void runTask('reprocess', { payload: { platform, externalId: id, force: true, trigger: 'manual' } }).catch((err: unknown) => {
    console.error('[settings/auction/reprocess-retry] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
