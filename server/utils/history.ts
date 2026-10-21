// Appends rows to auction_observations (Postgres) for crawler runs. Refresh
// records the list-level source view; enrich records the final
// detail/extraction-decorated payload. This is the append-only history the
// serving tables do not keep. No-op when Postgres isn't configured.
//
// A row is only written when the auction's payload changed since the last
// row of the same kind (auction_observation_heads), plus one daily detail row
// per auction. Writing every run stored ~300k identical rows a day.

import type { Pool } from 'pg'
import type { Auction, CrawlResult } from '~/types/auction'
import { getPool } from './db'
import { canonicalize, sha256Hex } from './raw-archive'

/** 'list' rows come from refresh and country rebuilds, 'detail' rows from enrich. */
export type ObservationKind = 'list' | 'detail'

// An unchanged detail payload is still written once a day, so the history
// keeps a daily series of every offered auction for trend analyses. Below
// 24 h so jitter in the 6-hourly enrich schedule cannot push the daily row to
// the run 30 h later. List rows hold nothing the same day's detail row lacks,
// so they are written on change only.
const DETAIL_HEARTBEAT_MS = 20 * 60 * 60 * 1000

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

/**
 * Content hash of an observation payload without per-run bookkeeping:
 * `detailFetchedAt` and the extraction's run timestamps change on every
 * enrich/reprocess pass while the auction stays the same. `marketValueEur` is
 * left out only when it is derived from `marketValue` + `currency` (live FX
 * rates move it every run); crawlers that set only the EUR value keep it in.
 */
export function observationPayloadHash(auction: Auction): string {
  const { detailFetchedAt: _detailFetchedAt, extraction, ...rest } = auction
  const content: Record<string, unknown> = { ...rest }
  if (auction.marketValue != null) delete content.marketValueEur
  if (extraction) {
    const { at: _at, llmAnalyzedAt: _llmAnalyzedAt, ...stable } = extraction
    content.extraction = stable
  } else {
    content.extraction = extraction ?? null
  }
  return sha256Hex(Buffer.from(JSON.stringify(canonicalize(content))))
}

export async function recordObservations(
  result: CrawlResult,
  capturedAt: string,
  kind: ObservationKind,
): Promise<void> {
  const db = getPool()
  if (!db) return
  if (result.auctions.length === 0) return

  for (let i = 0; i < result.auctions.length; i += CHUNK_SIZE) {
    await recordChunk(db, result.auctions.slice(i, i + CHUNK_SIZE), capturedAt, kind)
  }
}

type ObservationHead = { hash: string; capturedAtMs: number }

async function recordChunk(db: Pool, auctions: Auction[], capturedAt: string, kind: ObservationKind): Promise<void> {
  const heads = await readHeads(db, auctions, kind)
  const capturedAtMs = Date.parse(capturedAt)
  const rows: ObservationRow[] = []
  const written = new Map<string, { platform: string; externalId: string; hash: string }>()
  for (const auction of auctions) {
    const key = `${auction.platform}:${auction.externalId}`
    const hash = observationPayloadHash(auction)
    const head = heads.get(key)
    const heartbeatDue = kind === 'detail' && (!head || capturedAtMs - head.capturedAtMs >= DETAIL_HEARTBEAT_MS)
    if (head && head.hash === hash && !heartbeatDue) continue
    // The chunk can list an auction twice; the second copy compares against
    // the first one's row, not the stale stored head.
    heads.set(key, { hash, capturedAtMs })
    written.set(key, { platform: auction.platform, externalId: auction.externalId, hash })
    rows.push(auctionToObservationRow(auction, capturedAt))
  }
  if (rows.length === 0) return
  await insertChunk(db, rows)
  // After the rows: a failed head write only costs a duplicate row next run,
  // the other order would drop a change.
  await writeHeads(db, [...written.values()], kind, capturedAt)
}

async function readHeads(db: Pool, auctions: Auction[], kind: ObservationKind): Promise<Map<string, ObservationHead>> {
  const { rows } = await db.query<{ platform: string; external_id: string; payload_hash: string; captured_at: Date | string }>(
    `SELECT platform, external_id, payload_hash, captured_at FROM auction_observation_heads
      WHERE kind = $1
        AND (platform, external_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [kind, auctions.map((a) => a.platform), auctions.map((a) => a.externalId)],
  )
  return new Map(rows.map((row) => [
    `${row.platform}:${row.external_id}`,
    { hash: row.payload_hash, capturedAtMs: new Date(row.captured_at).getTime() },
  ]))
}

async function writeHeads(
  db: Pool,
  heads: Array<{ platform: string; externalId: string; hash: string }>,
  kind: ObservationKind,
  capturedAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO auction_observation_heads (platform, external_id, kind, payload_hash, captured_at)
     SELECT platform, external_id, $1, payload_hash, $2 FROM unnest($3::text[], $4::text[], $5::text[])
       AS h(platform, external_id, payload_hash)
     ON CONFLICT (platform, external_id, kind)
       DO UPDATE SET payload_hash = EXCLUDED.payload_hash, captured_at = EXCLUDED.captured_at`,
    [kind, capturedAt, heads.map((h) => h.platform), heads.map((h) => h.externalId), heads.map((h) => h.hash)],
  )
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
