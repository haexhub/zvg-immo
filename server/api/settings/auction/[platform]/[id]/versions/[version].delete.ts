// Delete a non-live version (docs/plans/2026-08-08-admin-auktions-technikseite.md,
// WP-5) — refused for the live version (promote another one first, see
// deleteAuctionDetailsVersion). Cascades (auction_photos, auction_translations)
// are declared on the FKs already, nothing to clean up here.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { deleteAuctionDetailsVersion } from '~/server/utils/auction-details'

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  const versionParam = String(getRouterParam(event, 'version') ?? '')
  const version = Number(versionParam)
  if (!isSafePathSegment(platform) || !isSafePathSegment(id) || !Number.isInteger(version)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id/version' })
  }

  const outcome = await deleteAuctionDetailsVersion(platform, id, version)
  if (outcome === 'not_found') {
    throw createError({ statusCode: 404, statusMessage: 'version not found' })
  }
  if (outcome === 'is_latest') {
    throw createError({ statusCode: 409, statusMessage: 'cannot delete the live version — promote another version first' })
  }
  return { deleted: true }
})
