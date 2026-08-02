// Lightweight single-auction lookup shaped exactly like AuctionSummary (the
// search grid's row type) — used as the map popover's fallback when the
// clicked marker isn't among the auctions the grid has already loaded, so it
// doesn't have to pull the full detail endpoint (live-crawler fallback,
// geocoding or aggregate reconstruction) just to show a compact card.

import type { AuctionSearchResponse } from '~/server/api/auctions.get'
import { SUMMARY_COLUMNS_SQL, SUMMARY_FROM_SQL, summary, type SearchRow } from '~/server/api/auctions.get'
import { getPool } from '~/server/utils/db'
import { isSafePathSegment } from '~/server/utils/path-segment'

export default defineEventHandler(async (event): Promise<AuctionSearchResponse['auctions'][number]> => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }

  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Auktionsdatenbank ist nicht konfiguriert' })
  }

  const { rows } = await db.query<SearchRow>(
    `SELECT ${SUMMARY_COLUMNS_SQL} ${SUMMARY_FROM_SQL} WHERE a.platform = $1 AND a.external_id = $2`,
    [platform, id],
  )
  const row = rows[0]
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  setResponseHeader(event, 'cache-control', 'no-store')
  return summary(row)
})
