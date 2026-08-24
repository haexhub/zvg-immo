import type { AuctionExtraction } from '~/types/auction'
import type { PropertyType } from '~/lib/property-type'
import type { Condition } from '~/lib/condition'
import type { Feature } from '~/lib/features'
import { getPool, isStatementTimeoutError, SEARCH_STATEMENT_TIMEOUT_MS, withStatementTimeout } from '~/server/utils/db'
import { buildAuctionSearchFilter, finiteNumber } from '~/server/utils/auction-search-filters'
import { curatedAuctionPhotoUrls } from '~/lib/auction-photos'
import { redactAffectedPersonNames } from '~/server/utils/public-auction-redaction'

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
  pdfUrl: string | null
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

// Shared with server/api/auction/[platform]/[id]/summary.get.ts and
// server/api/landing/rails.get.ts, which reuse this exact column list and JOIN
// shape — the map popover's fallback for a marker outside the loaded page, and
// the landing rails respectively.
//
// Object/price/extraction fields come from the newest `auction_details`
// version. Display-only crawl state lives in auction_fetch_state; curated
// photos are aggregated from the current details version.
export const SUMMARY_COLUMNS_SQL = `
  a.platform, a.country, a.region, a.external_id, a.case_number, a.authority,
  a.title, a.auction_date_iso, a.cancelled,
  d.address, d.market_value, d.currency, d.market_value_eur,
  d.starting_bid, d.current_bid, d.photo_count, d.thumbnail_url,
  d.property_type, d.land_area_sqm, d.living_area_sqm, d.year_built,
  d.last_renovation_year, d.condition, d.features, d.extraction_source,
  d.llm_analyzed_at,
  d.market_value_text,
  a.auction_date_text,
  fs.pdf_url,
  photos.items AS photos`

/**
 * Live extraction version per auction. LATERAL rather than a top-level
 * `DISTINCT ON (platform, external_id) … ORDER BY version DESC` because the
 * query is driven from `auctions`: this walks the partial unique index
 * idx_auction_details_latest once per matched auction — an index lookup on
 * is_latest, not a version sort — instead of scanning the whole history
 * table first. Also the reason this must stay `is_latest`, not
 * `ORDER BY version DESC LIMIT 1`: a WP-0 trial version can outrank the live
 * row in version without ever being it, and search must never surface one.
 */
export const LATEST_DETAILS_JOIN_SQL = `LEFT JOIN LATERAL (
    SELECT ad.* FROM auction_details ad
    WHERE ad.platform = a.platform AND ad.external_id = a.external_id AND ad.is_latest = true
  ) d ON true`

// GIS WP-5: the Umgebung/proximity filters in auction-search-filters.ts
// compare against this join's columns (m.dist_sea_m <= …) instead of doing a
// live osm_local_elements lookup — must be a LEFT JOIN, not JOIN: an
// ungeocoded auction has no metrics row and must still show up whenever no
// geofilter is active (see auction-search-filters.ts's proximity-filter loop).
//
// Exported separately from SUMMARY_FROM_SQL because /api/auctions-geo builds
// its own, much narrower marker query but shares the same predicate — every
// query that applies buildAuctionSearchFilter must carry this join, or an
// active geofilter references a missing `m`.
export const GEO_METRICS_JOIN_SQL = `LEFT JOIN auction_geo_metrics m
    ON m.platform = a.platform AND m.external_id = a.external_id`

export const SUMMARY_FROM_SQL = `FROM auctions a
  ${LATEST_DETAILS_JOIN_SQL}
  ${GEO_METRICS_JOIN_SQL}
  LEFT JOIN auction_fetch_state fs
    ON fs.platform = a.platform AND fs.external_id = a.external_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'file', ap.file,
      'category', ap.category,
      'caption', ap.caption,
      'isPropertyPhoto', ap.is_property_photo,
      'appealScore', ap.appeal_score
    ) ORDER BY ap.ordinal) AS items
    FROM auction_photos ap
    WHERE ap.auction_details_id = d.id
  ) photos ON true`

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

export interface SearchRow {
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
  photo_count: number | null
  thumbnail_url: string | null
  pdf_url: string | null
  property_type: PropertyType | null
  land_area_sqm: string | number | null
  living_area_sqm: string | number | null
  year_built: number | null
  last_renovation_year: number | null
  condition: Condition | null
  features: Feature[] | null
  extraction_source: 'rules' | 'llm' | null
  llm_analyzed_at: Date | string | null
  photos: AuctionExtraction['photos'] | null
}

export function summary(row: SearchRow): AuctionSummary {
  return {
    platform: row.platform,
    country: row.country,
    region: row.region,
    externalId: row.external_id,
    caseNumber: row.case_number,
    authority: row.authority,
    title: redactAffectedPersonNames(row.title) ?? null,
    address: redactAffectedPersonNames(row.address) ?? null,
    marketValue: finiteNumber(row.market_value),
    currency: row.currency,
    marketValueEur: finiteNumber(row.market_value_eur),
    marketValueText: redactAffectedPersonNames(row.market_value_text) ?? null,
    startingBid: finiteNumber(row.starting_bid),
    currentBid: finiteNumber(row.current_bid),
    auctionDateIso: row.auction_date_iso,
    auctionDateText: row.auction_date_text,
    cancelled: row.cancelled,
    photoCount: row.photo_count ?? 0,
    thumbnailUrl: row.thumbnail_url,
    galleryUrls: curatedAuctionPhotoUrls(row.platform, row.external_id, row.photos ?? undefined, row.thumbnail_url),
    pdfUrl: row.pdf_url,
    // `source` is required on AuctionExtraction, so a row without it is an
    // auction that has no extraction rather than one with empty fields.
    extraction: row.extraction_source
      ? {
          propertyType: row.property_type,
          landAreaSqm: finiteNumber(row.land_area_sqm),
          livingAreaSqm: finiteNumber(row.living_area_sqm),
          yearBuilt: row.year_built,
          lastRenovationYear: row.last_renovation_year,
          condition: row.condition,
          features: row.features ?? undefined,
          source: row.extraction_source,
          llmAnalyzedAt: isoOrNull(row.llm_analyzed_at) ?? undefined,
        }
      : null,
  }
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
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
      ? 'd.market_value_eur ASC NULLS LAST, a.platform, a.external_id'
      : sort === 'priceDesc'
        ? 'd.market_value_eur DESC NULLS LAST, a.platform, a.external_id'
        : 'd.photo_count DESC NULLS LAST, a.updated_at DESC, a.platform, a.external_id'

  const from = SUMMARY_FROM_SQL
  const rowsSql = `SELECT ${SUMMARY_COLUMNS_SQL}
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
  const categoriesSql = `SELECT d.property_type AS id, count(*)::int AS count
    ${from} ${predicate ? `${predicate} AND d.property_type IS NOT NULL` : `WHERE d.property_type IS NOT NULL`}
    GROUP BY d.property_type ORDER BY count DESC, d.property_type`

  // Search-Grid: once the map has a viewport, pages/search.vue repeats this
  // request on every pan/zoom purely to page through the visible rows — the
  // header's Properties popover already gets its courts/categories facets
  // from the initial, unscoped call. Skip re-deriving them here so a pan
  // doesn't double a request that already opens four DB connections.
  const skipFacets = String(query.skipFacets ?? '') === '1'

  // Facet queries reuse the filter parameters but not LIMIT/OFFSET. Each gets
  // its own withStatementTimeout call — and therefore its own connection —
  // run together via Promise.all: a single Postgres connection only ever
  // processes one statement at a time, so bundling all four onto one
  // connection would silently serialize them (no real parallelism despite
  // the Promise.all) and, worse, would let their SET LOCAL statement_timeout
  // windows add up to ~4x SEARCH_STATEMENT_TIMEOUT_MS worst case instead of
  // capping the whole request at SEARCH_STATEMENT_TIMEOUT_MS. Four
  // connections per search request is unchanged from before this file
  // started using withStatementTimeout.
  let rowsResult, statsResult
  let authoritiesResult: { rows: Array<{ authority: string }> } = { rows: [] }
  let categoriesResult: { rows: Array<{ id: string; count: number }> } = { rows: [] }
  try {
    ;[rowsResult, statsResult, authoritiesResult, categoriesResult] = await Promise.all([
      withStatementTimeout(db, SEARCH_STATEMENT_TIMEOUT_MS, (client) =>
        client.query<SearchRow>(rowsSql, [...filterValues, pageSize, offset])),
      withStatementTimeout(db, SEARCH_STATEMENT_TIMEOUT_MS, (client) =>
        client.query<{ total: number; active: number; cancelled: number }>(statsSql, filterValues)),
      skipFacets
        ? Promise.resolve(authoritiesResult)
        : withStatementTimeout(db, SEARCH_STATEMENT_TIMEOUT_MS, (client) =>
          client.query<{ authority: string }>(authoritiesSql, filterValues)),
      skipFacets
        ? Promise.resolve(categoriesResult)
        : withStatementTimeout(db, SEARCH_STATEMENT_TIMEOUT_MS, (client) =>
          client.query<{ id: string; count: number }>(categoriesSql, filterValues)),
    ])
  } catch (err) {
    if (isStatementTimeoutError(err)) {
      throw createError({ statusCode: 503, statusMessage: 'Suche zu aufwendig, bitte Filter einschränken.' })
    }
    throw err
  }
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
