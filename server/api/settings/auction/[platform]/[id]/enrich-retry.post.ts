// Admin single-auction crawl/archive (re)trigger for the /settings
// crawl-status card's per-row retry button. Scoped via enrich-worker.ts's
// `identities` option — skips the live region crawl and re-archives exactly
// this one already-known auction, regardless of whether it currently looks
// done.
//
// Detached like the other single-auction admin triggers (translation-retry,
// reprocess-retry): a detail/document/photo re-archive can take a while, and
// /settings has no dedicated status endpoint to await — the crawl-status
// card just re-polls its list.

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

  void runTask('enrich', {
    payload: { country: record.auction.country, identities: [{ platform, externalId: id }] },
  }).catch((err: unknown) => {
    console.error('[settings/auction/enrich-retry] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
