import type { AuctionExtraction } from '~/types/auction'
import { getPool } from '~/server/utils/db'
import { buildAuctionSearchFilter, finiteNumber } from '~/server/utils/auction-search-filters'
import { curatedAuctionPhotoUrls } from '~/lib/auction-photos'

export interface AuctionSummary {
  platform: string
  country: string
  region: string
  externalId: string
  caseNumber: string
  authority: string
  title: string | null
  address: string | null
  marketValue: number | null
  currency: string | null
  marketValueEur: number | null
  marketValueText: string | null
  startingBid: number | null
  currentBid: number | null
  auctionDateIso: string | null
  auctionDateText: string | null
  cancelled: boolean
  photoCount: number
  thumbnailUrl: string | null
  /** Compact, display-ready gallery URLs for the card slider. */
  galleryUrls: string[]
  extraction: Pick<
    AuctionExtraction,
    | 'propertyType'
    | 'landAreaSqm'
    | 'livingAreaSqm'
    | 'yearBuilt'
    | 'lastRenovationYear'
    | 'condition'
    | 'features'
    | 'source'
    | 'llmAnalyzedAt'
  > | null
}

export interface AuctionSearchResponse {
  auctions: AuctionSummary[]
  total: number
  active: number
  cancelled: number
  page: number
  pageSize: number
  fetchedAt: string
  facets: {
    authorities: string[]
    categories: Array<{ id: string; count: number }>
  }
}

interface SearchRow {
  platform: string
  country: string
  region: string
  external_id: string
  case_number: string
  authority: string
  title: string | null
  address: string | null
  market_value: string | number | null
  currency: string | null
  market_value_eur: string | number | null
  market_value_text: string | null
  starting_bid: string | number | null
  current_bid: string | number | null
  auction_date_iso: string | null
  auction_date_text: string | null
  cancelled: boolean
  photo_count: number
  thumbnail_url: string | null
  extraction: AuctionExtraction | null
}

function summary(row: SearchRow): AuctionSummary {
  const extraction = row.extraction
  return {
    platform: row.platform,
    country: row.country,
    region: row.region,
    externalId: row.external_id,
    caseNumber: row.case_number,
    authority: row.authority,
    title: row.title,
    address: row.address,
    marketValue: finiteNumber(row.market_value),
    currency: row.currency,
    marketValueEur: finiteNumber(row.market_value_eur),
    marketValueText: row.market_value_text,
    startingBid: finiteNumber(row.starting_bid),
    currentBid: finiteNumber(row.current_bid),
    auctionDateIso: row.auction_date_iso,
    auctionDateText: row.auction_date_text,
    cancelled: row.cancelled,
    photoCount: row.photo_count,
    thumbnailUrl: row.thumbnail_url,
    galleryUrls: curatedAuctionPhotoUrls(row.platform, row.external_id, extraction?.photos, row.thumbnail_url),
    extraction: extraction
      ? {
          propertyType: extraction.propertyType,
          landAreaSqm: extraction.landAreaSqm,
          livingAreaSqm: extraction.livingAreaSqm,
          yearBuilt: extraction.yearBuilt,
          lastRenovationYear: extraction.lastRenovationYear,
          condition: extraction.condition,
          features: extraction.features,
          source: extraction.source,
          llmAnalyzedAt: extraction.llmAnalyzedAt,
        }
      : null,
  }
}

export default defineEventHandler(async (event): Promise<AuctionSearchResponse> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Auktionsdatenbank ist nicht konfiguriert' })
  }

  const query = getQuery(event)
  const { predicate, values: filterValues } = await buildAuctionSearchFilter(db, query)
  const pageSize = Math.min(60, Math.max(1, Math.trunc(finiteNumber(query.pageSize) ?? 30)))
  const page = Math.max(1, Math.trunc(finiteNumber(query.page) ?? 1))
  const offset = (page - 1) * pageSize
  const sort = String(query.sort ?? 'default')
  const orderBy = sort === 'dateAsc'
    ? 'a.auction_date_iso ASC NULLS LAST, a.platform, a.external_id'
    : sort === 'priceAsc'
      ? 'a.market_value_eur ASC NULLS LAST, a.platform, a.external_id'
      : sort === 'priceDesc'
        ? 'a.market_value_eur DESC NULLS LAST, a.platform, a.external_id'
        : 'a.photo_count DESC, a.updated_at DESC, a.platform, a.external_id'

  const from = `FROM auctions a
    LEFT JOIN extraction_cache ec
      ON ec.platform = a.platform AND ec.external_id = a.external_id
    LEFT JOIN auction_snapshot s
      ON s.platform = a.platform AND s.external_id = a.external_id`
  const rowsSql = `SELECT
      a.platform, a.country, a.region, a.external_id, a.case_number, a.authority,
      a.title, a.address, a.market_value, a.currency, a.market_value_eur,
      s.auction->>'marketValueText' AS market_value_text,
      a.starting_bid, a.current_bid, a.auction_date_iso,
      s.auction->>'auctionDateText' AS auction_date_text,
      a.cancelled, a.photo_count, a.thumbnail_url, ec.extraction
    ${from} ${predicate}
    ORDER BY ${orderBy}
    LIMIT $${filterValues.length + 1} OFFSET $${filterValues.length + 2}`
  const statsSql = `SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE a.cancelled = false)::int AS active,
      count(*) FILTER (WHERE a.cancelled = true)::int AS cancelled
    ${from} ${predicate}`
  const authoritiesSql = `SELECT DISTINCT a.authority ${from} ${
    predicate ? `${predicate} AND a.authority <> ''` : `WHERE a.authority <> ''`
  } ORDER BY a.authority`
  const categoriesSql = `SELECT a.property_type AS id, count(*)::int AS count
    ${from} ${predicate ? `${predicate} AND a.property_type IS NOT NULL` : `WHERE a.property_type IS NOT NULL`}
    GROUP BY a.property_type ORDER BY count DESC, a.property_type`

  // Facet queries reuse the filter parameters but not LIMIT/OFFSET.
  const [rowsResult, statsResult, authoritiesResult, categoriesResult] = await Promise.all([
    db.query<SearchRow>(rowsSql, [...filterValues, pageSize, offset]),
    db.query<{ total: number; active: number; cancelled: number }>(statsSql, filterValues),
    db.query<{ authority: string }>(authoritiesSql, filterValues),
    db.query<{ id: string; count: number }>(categoriesSql, filterValues),
  ])
  const stats = statsResult.rows[0] ?? { total: 0, active: 0, cancelled: 0 }
  setResponseHeader(event, 'cache-control', 'no-store')
  return {
    auctions: rowsResult.rows.map(summary),
    total: stats.total,
    active: stats.active,
    cancelled: stats.cancelled,
    page,
    pageSize,
    fetchedAt: new Date().toISOString(),
    facets: {
      authorities: authoritiesResult.rows.map((row) => row.authority),
      categories: categoriesResult.rows,
    },
  }
})
