// Persists the stable auction identity and listing-level scheduling fields.
// Object, price and extraction data live exclusively in auction_details.
// Coordinates live here, not on auction_details (WP-0): a position is
// identity, not an extraction result — see docs/plans/2026-08-04-gis-wp0-schema-neuaufbau.md.

import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import { getPool } from './db'
import type { GeocodeStatus } from './geocode'

const COLUMNS = [
  'platform',
  'external_id',
  'country',
  'region',
  'authority',
  'case_number',
  'title',
  'auction_date_iso',
  'auction_date_text',
  'cancelled',
  'lat',
  'lng',
  'updated_at',
] as const

export type CurrentAuctionRow = {
  platform: string
  external_id: string
  country: string
  region: string
  authority: string
  case_number: string
  title: string | null
  auction_date_iso: string | null
  auction_date_text: string | null
  cancelled: boolean
  lat: number | null
  lng: number | null
  updated_at: string
}

export function auctionToCurrentRow(a: Auction, updatedAt: string): CurrentAuctionRow {
  return {
    platform: a.platform,
    external_id: a.externalId,
    country: a.country,
    region: a.region,
    authority: a.authority,
    case_number: a.caseNumber,
    title: a.title,
    auction_date_iso: a.auctionDateIso,
    auction_date_text: a.auctionDateText,
    cancelled: a.cancelled,
    lat: a.lat ?? null,
    lng: a.lng ?? null,
    updated_at: updatedAt,
  }
}

// Geocoders return slightly different coordinates for the same address between
// runs, so an exact comparison would re-enrich constantly. 100 m is well above
// that noise and well below the distance at which the location context (nearby
// amenities, hazard zones, noise bands) would meaningfully differ.
const COORDINATE_CHANGE_THRESHOLD_METERS = 100

// node-postgres returns `numeric` as a string to avoid float precision loss.
function numeric(value: number | string | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Exported for tests. */
export function coordinatesMovedSignificantly(
  previous: { lat: number | null; lng: number | null } | null,
  next: { lat: number | null; lng: number | null },
): boolean {
  if (next.lat == null || next.lng == null) return false
  // First coordinates this auction ever had — including a brand new auction,
  // whose identity row is created before any geocoding has run.
  if (previous?.lat == null || previous?.lng == null) return true
  return distanceMeters(previous.lat, previous.lng, next.lat, next.lng) > COORDINATE_CHANGE_THRESHOLD_METERS
}

/**
 * Fire-and-forget re-enrichment of one auction's location context.
 *
 * The nightly full sweep stays the mechanism for externally-updated datasets
 * (EU flood zones, EFFIS, EEA noise, CAMS air quality) — those change without
 * anything happening on the auction side. It is not enough for "this auction's
 * coordinates just moved", though: up to 24 h of wrong context. Never awaited,
 * so the crawl/geocode path doesn't wait on external HTTP.
 */
function triggerLocationEnrichment(platform: string, externalId: string): void {
  // Absent outside the Nitro runtime (unit tests), where there is no task to run.
  if (typeof runTask !== 'function') return
  void runTask('external-enrichment', { payload: { platform, externalId } }).catch((err: unknown) => {
    console.error(`[current-auctions] external enrichment trigger failed for ${platform}/${externalId}: ${(err as Error).message}`)
  })
}

const UPDATE_COLUMNS = COLUMNS.filter((column) => column !== 'platform' && column !== 'external_id')
const CHUNK_SIZE = 500

/**
 * Creates missing identities without changing an existing row. This runs
 * before artifact writers so their foreign keys always have a parent.
 */
export async function ensureAuctionIdentity(auctions: Auction[]): Promise<void> {
  const db = getPool()
  if (!db || auctions.length === 0) return
  const rows = dedupeRows(auctions, new Date().toISOString())
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await insertChunk(db, rows.slice(i, i + CHUNK_SIZE), false)
  }
}

/**
 * Updates the current identity and scheduling fields after a crawl/enrich run.
 * Re-enriches location context for any auction whose coordinates moved
 * significantly since the previous run — see coordinatesMovedSignificantly.
 */
export async function upsertCurrentAuctions(auctions: Auction[], updatedAt: string): Promise<void> {
  const db = getPool()
  if (!db || auctions.length === 0) return
  const rows = dedupeRows(auctions, updatedAt)
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE)
    const previous = await previousCoordinates(db, chunk)
    await insertChunk(db, chunk, true)
    for (const row of chunk) {
      const key = `${row.platform}:${row.external_id}`
      if (coordinatesMovedSignificantly(previous.get(key) ?? null, { lat: row.lat, lng: row.lng })) {
        triggerLocationEnrichment(row.platform, row.external_id)
      }
    }
  }
}

async function previousCoordinates(
  db: Pool,
  rows: CurrentAuctionRow[],
): Promise<Map<string, { lat: number | null; lng: number | null }>> {
  const values: unknown[] = []
  const tuples = rows.map((row) => {
    values.push(row.platform, row.external_id)
    return `($${values.length - 1}, $${values.length})`
  })
  const { rows: previousRows } = await db.query<{ platform: string; external_id: string; lat: number | null; lng: number | null }>(
    `SELECT platform, external_id, lat, lng FROM auctions WHERE (platform, external_id) IN (${tuples.join(', ')})`,
    values,
  )
  return new Map(previousRows.map((row) => [
    `${row.platform}:${row.external_id}`,
    { lat: numeric(row.lat), lng: numeric(row.lng) },
  ]))
}

function dedupeRows(auctions: Auction[], updatedAt: string): CurrentAuctionRow[] {
  const deduped = new Map<string, CurrentAuctionRow>()
  for (const auction of auctions) {
    const row = auctionToCurrentRow(auction, updatedAt)
    deduped.set(`${row.platform}:${row.external_id}`, row)
  }
  return [...deduped.values()]
}

async function insertChunk(db: Pool, rows: CurrentAuctionRow[], update: boolean): Promise<void> {
  const values: unknown[] = []
  const tuples = rows.map((row) => {
    const placeholders = COLUMNS.map((column) => {
      values.push(row[column])
      return `$${values.length}`
    })
    return `(${placeholders.join(', ')})`
  })
  const conflict = update
    ? `DO UPDATE SET ${UPDATE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`
    : 'DO NOTHING'
  await db.query(
    `INSERT INTO auctions (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
     ON CONFLICT (platform, external_id) ${conflict}`,
    values,
  )
}

export interface GeocodeAttempt {
  platform: string
  externalId: string
  /** 'geocoded' | 'unresolvable' | 'pending' — see geocodeStatus() in
   *  geocode.ts. 'pending' means this run only got partway through the
   *  address's query variants (e.g. the failure cooldown was active). */
  result: GeocodeStatus
  provider: 'nominatim' | 'locationiq'
}

/**
 * Records that a backfill run considered an auction's address, independent of
 * whether it resolved to coordinates — the only way to tell "never attempted"
 * apart from "attempted, still unresolved" (see WP-3). Auctions that already
 * have lat/lng need no attempt and are never passed here.
 */
export async function recordGeocodeAttempts(attempts: GeocodeAttempt[], attemptedAt: string): Promise<void> {
  const db = getPool()
  if (!db || attempts.length === 0) return
  for (let i = 0; i < attempts.length; i += CHUNK_SIZE) {
    const chunk = attempts.slice(i, i + CHUNK_SIZE)
    const values: unknown[] = []
    const tuples = chunk.map((a) => {
      values.push(a.platform, a.externalId, attemptedAt, a.result, a.provider)
      const o = values.length
      return `($${o - 4}, $${o - 3}, $${o - 2}::timestamptz, $${o - 1}, $${o})`
    })
    await db.query(
      `UPDATE auctions SET
         geocode_attempted_at = v.attempted_at,
         geocode_result = v.result,
         geocode_provider = v.provider
       FROM (VALUES ${tuples.join(', ')}) AS v(platform, external_id, attempted_at, result, provider)
       WHERE auctions.platform = v.platform AND auctions.external_id = v.external_id`,
      values,
    )
  }
}
