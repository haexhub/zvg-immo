// GET /api/data/v1/auctions/:platform/:id — single-auction lookup for the
// Daten-API (guarded by server/middleware/data-api-auth.ts). Same
// PublicAuction contract as ../auctions.get.ts.

import { readAuctionRecord } from '../../../../../utils/auction-record'
import { toPublicAuction, type PublicAuction } from '../../../../../utils/data-api-shape'

export default defineEventHandler(async (event): Promise<PublicAuction> => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!platform || !id) {
    throw createError({ statusCode: 400, statusMessage: 'platform/id fehlt.' })
  }

  const record = await readAuctionRecord(platform, id)
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: 'Auktion nicht gefunden.' })
  }
  return toPublicAuction(record.auction)
})
