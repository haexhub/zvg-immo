// GET /api/data/v1/auctions — structured current auctions for the Daten-API
// (guarded by server/middleware/data-api-auth.ts). Response uses the stable,
// documented PublicAuction contract (server/utils/data-api-shape.ts), not the
// internal Auction type, and is paginated.

import { readAuctionRecords } from '../../../utils/auction-record'
import { toPublicAuction, type PublicAuction } from '../../../utils/data-api-shape'
import { parsePagination } from '../../../utils/data-api-pagination'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export interface PaginatedResponse<T> {
  data: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export default defineEventHandler(async (event): Promise<PaginatedResponse<PublicAuction>> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : undefined
  const region = typeof query.region === 'string' ? query.region : undefined
  const platform = typeof query.platform === 'string' ? query.platform : undefined
  const propertyType = typeof query.propertyType === 'string' ? query.propertyType : undefined
  const includeWithdrawn = query.includeWithdrawn === '1'
  const { page, pageSize } = parsePagination(query, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

  const auctions = (await readAuctionRecords(country, { includePhotos: false })).map((record) => record.auction)

  const filtered = auctions.filter((a) => {
    if (region && a.region !== region) return false
    if (platform && a.platform !== platform) return false
    if (propertyType && a.extraction?.propertyType !== propertyType) return false
    if (!includeWithdrawn && a.cancelled) return false
    return true
  })

  const total = filtered.length
  const start = (page - 1) * pageSize
  const pageItems = filtered.slice(start, start + pageSize)

  return {
    data: pageItems.map(toPublicAuction),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
})
