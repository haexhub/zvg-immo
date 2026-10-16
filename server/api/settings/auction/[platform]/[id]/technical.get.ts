// Aggregate technical overview for one auction identity (docs/plans/2026-08-08-
// admin-auktions-technikseite.md, WP-2). Behind server/middleware/settings-auth.ts
// via the /api/settings/* prefix — the page itself lives at
// /admin/auktion/[platform]/[id] (not under /settings, see the plan's routing
// decision), but the guard only protects this prefix.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { readAuctionTechnicalOverview, type AuctionTechnicalOverview } from '~/server/utils/auction-technical'

export default defineEventHandler(async (event): Promise<AuctionTechnicalOverview> => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }

  const overview = await readAuctionTechnicalOverview(platform, id)
  if (!overview) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  return overview
})
