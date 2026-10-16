// GET /api/data/v1/auctions — structured current auctions for the Daten-API
// (guarded by server/middleware/data-api-auth.ts). Response uses the stable,
// documented PublicAuction contract (server/utils/data-api-shape.ts), not the
// internal Auction type, and is paginated.

import { type PublicAuction } from '../../../utils/data-api-shape'
import { parsePagination } from '../../../utils/data-api-pagination'
import { readPublicAuctions } from '../../../utils/data-api-auction'

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

  const { data, total } = await readPublicAuctions({
    country, region, platform, propertyType, includeWithdrawn, page, pageSize,
  })

  return {
    data,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
})
