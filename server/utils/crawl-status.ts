// Admin overview for the crawl/detail-fetch pipeline, per country. Unlike
// the LLM side (auction_fetch_state.llm_failures), there is no persistent
// per-auction failure counter for the detail crawl — enrich.ts just retries
// whatever isn't detail-fetched yet on every run. 'error' is therefore
// derived from whether the most recent task_run_errors row for that
// identity (task='enrich') is still unresolved, i.e. no successful
// detail_fetched_at exists yet.

import { getPool } from './db'

export type CrawlStatusBucket = 'done' | 'error' | 'open'

export interface CrawlStatusCounts {
  done: number
  error: number
  open: number
  total: number
}

export interface CrawlStatusItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  auctionDateIso: string | null
  lastErrorMessage: string | null
}

export interface CrawlStatusList {
  items: CrawlStatusItem[]
  total: number
}

export const CRAWL_STATUS_SORTS = ['platform', 'title', 'region', 'error'] as const
export type CrawlStatusSort = typeof CRAWL_STATUS_SORTS[number]

export interface CrawlStatusListOptions {
  limit?: number
  offset?: number
  search?: string
  sort?: CrawlStatusSort
  direction?: 'asc' | 'desc'
}

// Shared by both queries below so the bucket definition can't drift between
// the per-country aggregate and the drill-down list.
const STATUS_CTE = `
WITH last_error AS (
  SELECT DISTINCT ON (platform, external_id) platform, external_id, message
  FROM task_run_errors
  WHERE task = 'enrich'
  ORDER BY platform, external_id, created_at DESC
),
crawl_status AS (
  SELECT
    a.platform, a.external_id, a.country, a.title, a.region, a.case_number,
    a.auction_date_iso, le.message AS last_error_message,
    CASE
      WHEN fs.detail_fetched_at IS NOT NULL THEN 'done'
      WHEN le.external_id IS NOT NULL THEN 'error'
      ELSE 'open'
    END AS bucket
  FROM auctions a
  LEFT JOIN auction_fetch_state fs ON fs.platform = a.platform AND fs.external_id = a.external_id
  LEFT JOIN last_error le ON le.platform = a.platform AND le.external_id = a.external_id
)
`

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

export async function readCrawlStatusByCountry(): Promise<Record<string, CrawlStatusCounts>> {
  const db = getPool()
  if (!db) return {}
  const { rows } = await db.query<{ country: string; bucket: CrawlStatusBucket; count: string }>(
    `${STATUS_CTE} SELECT country, bucket, count(*) AS count FROM crawl_status GROUP BY country, bucket`,
  )
  const out: Record<string, CrawlStatusCounts> = {}
  for (const row of rows) {
    const counts = out[row.country] ?? (out[row.country] = { done: 0, error: 0, open: 0, total: 0 })
    const n = Number(row.count)
    counts[row.bucket] += n
    counts.total += n
  }
  return out
}

/** Every identity in one country/bucket, unpaginated — feeds the crawl-status
 *  card's "nur offene"/"nur fehlerhafte" bulk retry buttons (see
 *  server/tasks/enrich-worker.ts's `identities` scoping), unlike
 *  readCrawlStatusList's paginated page-at-a-time shape for the drill-down
 *  table. */
export async function readCrawlStatusIdentities(
  country: string,
  bucket: CrawlStatusBucket,
): Promise<{ platform: string; externalId: string }[]> {
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<{ platform: string; external_id: string }>(
    `${STATUS_CTE} SELECT platform, external_id FROM crawl_status WHERE country = $1 AND bucket = $2`,
    [country, bucket],
  )
  return rows.map((row) => ({ platform: row.platform, externalId: row.external_id }))
}

export async function readCrawlStatusList(
  country: string,
  bucket: CrawlStatusBucket,
  { limit = 50, offset = 0, search = '', sort, direction = 'asc' }: CrawlStatusListOptions = {},
): Promise<CrawlStatusList> {
  const db = getPool()
  if (!db) return { items: [], total: 0 }
  const filter = search.trim()
  if (filter || sort) {
    const orderBy: Record<CrawlStatusSort, string> = {
      platform: 'platform',
      title: 'title',
      region: 'region',
      error: 'last_error_message',
    }
    const params: (string | number)[] = [country, bucket]
    const filterClause = filter
      ? ` AND concat_ws(' ', platform, external_id, title, region, case_number, last_error_message) ILIKE $${params.push(`%${filter}%`)}`
      : ''
    const order = `${orderBy[sort || 'platform']} ${direction === 'desc' ? 'DESC' : 'ASC'}, platform ASC, external_id ASC`
    const pageParams = [...params, limit, offset]
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query<{
        platform: string; external_id: string; title: string | null; region: string; case_number: string
        auction_date_iso: Date | string | null; last_error_message: string | null
      }>(
        `${STATUS_CTE} SELECT platform, external_id, title, region, case_number, auction_date_iso, last_error_message
         FROM crawl_status WHERE country = $1 AND bucket = $2${filterClause}
         ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        pageParams,
      ),
      db.query<{ count: string }>(
        `${STATUS_CTE} SELECT count(*) AS count FROM crawl_status WHERE country = $1 AND bucket = $2${filterClause}`,
        params,
      ),
    ])
    return {
      items: rows.map((row) => ({
        platform: row.platform, externalId: row.external_id, title: row.title, region: row.region,
        caseNumber: row.case_number, auctionDateIso: isoOrNull(row.auction_date_iso), lastErrorMessage: row.last_error_message,
      })),
      total: Number(countRows[0]?.count ?? 0),
    }
  }
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query<{
      platform: string
      external_id: string
      title: string | null
      region: string
      case_number: string
      auction_date_iso: Date | string | null
      last_error_message: string | null
    }>(
      `${STATUS_CTE} SELECT platform, external_id, title, region, case_number, auction_date_iso, last_error_message
       FROM crawl_status WHERE country = $1 AND bucket = $2
       ORDER BY platform, external_id LIMIT $3 OFFSET $4`,
      [country, bucket, limit, offset],
    ),
    db.query<{ count: string }>(
      `${STATUS_CTE} SELECT count(*) AS count FROM crawl_status WHERE country = $1 AND bucket = $2`,
      [country, bucket],
    ),
  ])
  return {
    items: rows.map((row) => ({
      platform: row.platform,
      externalId: row.external_id,
      title: row.title,
      region: row.region,
      caseNumber: row.case_number,
      auctionDateIso: isoOrNull(row.auction_date_iso),
      lastErrorMessage: row.last_error_message,
    })),
    total: Number(countRows[0]?.count ?? 0),
  }
}
