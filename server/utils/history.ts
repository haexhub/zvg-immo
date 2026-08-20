// Appends one row per auction to auction_observations (Postgres) for crawler
// runs. Refresh records the list-level source view; enrich records the final
// detail/extraction-decorated payload. This is the append-only history the
// serving tables do not keep. No-op when Postgres isn't configured.

import type { Pool } from 'pg'
import type { Auction, CrawlResult } from '~/types/auction'
import { getPool } from './db'

const COLUMNS = [
  'captured_at',
  'platform',
  'country',
  'region',
  'external_id',
  'authority',
  'case_number',
  'title',
  'property_type',
  'land_area_sqm',
  'living_area_sqm',
  'rooms',
  'units',
  'market_value_eur',
  'market_value',
  'currency',
  'auction_date_iso',
  'cancelled',
  'payload',
] as const

export type ObservationRow = {
  captured_at: string
  platform: string
  country: string
  region: string
  external_id: string
  authority: string
  case_number: string
  title: string | null
  property_type: string | null
  land_area_sqm: number | null
  living_area_sqm: number | null
  rooms: number | null
  units: number | null
  market_value_eur: number | null
  market_value: number | null
  currency: string | null
  auction_date_iso: string | null
  cancelled: boolean
  payload: Auction
}

export function auctionToObservationRow(a: Auction, capturedAt: string): ObservationRow {
  return {
    captured_at: capturedAt,
    platform: a.platform,
    country: a.country,
    region: a.region,
    external_id: a.externalId,
    authority: a.authority,
    case_number: a.caseNumber,
    title: a.title,
    property_type: a.extraction?.propertyType ?? null,
    land_area_sqm: a.extraction?.landAreaSqm ?? null,
    living_area_sqm: a.extraction?.livingAreaSqm ?? null,
    rooms: a.extraction?.rooms ?? null,
    units: a.extraction?.units ?? null,
    market_value_eur: a.marketValueEur,
    market_value: a.marketValue ?? null,
    currency: a.currency ?? null,
    auction_date_iso: a.auctionDateIso,
    cancelled: a.cancelled,
    payload: a,
  }
}

// Chunk size keeps well under Postgres' 65535-parameter-per-query limit
// (16 columns × 500 rows = 8000 params) while still batching efficiently.
const CHUNK_SIZE = 500

export async function recordObservations(result: CrawlResult, capturedAt: string): Promise<void> {
  const db = getPool()
  if (!db) return
  if (result.auctions.length === 0) return

  const rows = result.auctions.map((a) => auctionToObservationRow(a, capturedAt))

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await insertChunk(db, rows.slice(i, i + CHUNK_SIZE))
  }
}

async function insertChunk(db: Pool, rows: ObservationRow[]): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const row of rows) {
    const placeholders = COLUMNS.map((_, i) => `$${values.length + i + 1}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(...COLUMNS.map((col) => col === 'payload' ? JSON.stringify(row.payload) : row[col]))
  }
  const sql = `INSERT INTO auction_observations (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`
  await db.query(sql, values)
}

/**
 * The most recent observed source record for one auction, or null when it was
 * never observed. Replaces the whole-country list_cache blob scan the detail
 * permalink used as its fallback: `payload` holds the same complete parsed
 * Auction, and idx_obs_platform_zvgid_time makes this a single indexed row
 * lookup instead of parsing every country's cached CrawlResult.
 *
 * Only a fallback — readAuctionRecord (the structured tables) is authoritative
 * and answers first. This covers the window where a crawl created the identity
 * but no enrich run has written auction_details yet, so the structured read
 * would return a row with no address or price.
 *
 * A query failure is thrown rather than swallowed to null: the caller treats
 * null as "genuinely never observed" and falls through to a live upstream
 * crawl, which would turn a database hiccup into a burst of external requests
 * on every affected detail page.
 */
export async function readLatestObservedAuction(
  platform: string,
  externalId: string,
): Promise<Auction | null> {
  const db = getPool()
  if (!db) return null
  const { rows } = await db.query<{ payload: Auction | null }>(
    `SELECT payload FROM auction_observations
      WHERE platform = $1 AND external_id = $2
      ORDER BY captured_at DESC
      LIMIT 1`,
    [platform, externalId],
  )
  return rows[0]?.payload ?? null
}
