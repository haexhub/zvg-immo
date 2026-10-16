// Promote a version to live (docs/plans/2026-08-08-admin-auktions-technikseite.md,
// WP-5) — used both to accept a trial run and to roll back to an older
// version. See promoteAuctionDetailsVersion for the transaction.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { promoteAuctionDetailsVersion } from '~/server/utils/auction-details'

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  const versionParam = String(getRouterParam(event, 'version') ?? '')
  const version = Number(versionParam)
  if (!isSafePathSegment(platform) || !isSafePathSegment(id) || !Number.isInteger(version)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id/version' })
  }

  const outcome = await promoteAuctionDetailsVersion(platform, id, version)
  if (outcome === 'not_found') {
    throw createError({ statusCode: 404, statusMessage: 'version not found' })
  }
  return { promoted: true }
})
