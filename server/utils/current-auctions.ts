// Upserts the current-state row for each auction into Postgres's `auctions`
// table (server/db/schema.sql) — a structured, indexed mirror of the JSON
// snapshot (auction-snapshot.ts) that lib/auction-filters.ts's client-side
// filterAuctions() reads today. Additive only: nothing reads from this table
// yet (see server/tasks/enrich.ts's call site) — it exists so SQL WHERE-
// clause filtering (Daten-API, admin tooling, a future server-side search)
// doesn't need a JSON-blob scan. No-op when Postgres isn't configured (see
// server/utils/db.ts), same graceful-degrade as history.ts/raw-archive.ts.

import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import { getPool } from './db'

const COLUMNS = [
  'platform',
  'external_id',
  'country',
  'region',
  'authority',
  'case_number',
  'title',
  'address',
  'description',
  'property_type',
  'land_area_sqm',
  'living_area_sqm',
  'rooms',
  'units',
  'market_value',
  'currency',
  'market_value_eur',
  'auction_date_iso',
  'cancelled',
  'photo_count',
  'thumbnail_url',
  'lat',
  'lng',
  'detail_fetched_at',
  'extraction_source',
  'extraction_confidence',
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
  address: string | null
  description: string | null
  property_type: string | null
  land_area_sqm: number | null
  living_area_sqm: number | null
  rooms: number | null
  units: number | null
  market_value: number | null
  currency: string | null
  market_value_eur: number | null
  auction_date_iso: string | null
  cancelled: boolean
  photo_count: number
  thumbnail_url: string | null
  lat: number | null
  lng: number | null
  detail_fetched_at: string | null
  extraction_source: string | null
  extraction_confidence: string | null
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
    address: a.address,
    description: a.description,
    property_type: a.extraction?.propertyType ?? null,
    land_area_sqm: a.extraction?.landAreaSqm ?? null,
    living_area_sqm: a.extraction?.livingAreaSqm ?? null,
    rooms: a.extraction?.rooms ?? null,
    units: a.extraction?.units ?? null,
    market_value: a.marketValue ?? null,
    currency: a.currency ?? null,
    market_value_eur: a.marketValueEur,
    auction_date_iso: a.auctionDateIso,
    cancelled: a.cancelled,
    photo_count: a.photoCount,
    thumbnail_url: a.thumbnailUrl,
    lat: a.lat ?? null,
    lng: a.lng ?? null,
    detail_fetched_at: a.detailFetchedAt ?? null,
    extraction_source: a.extraction?.source ?? null,
    extraction_confidence: a.extraction?.confidence ?? null,
    updated_at: updatedAt,
  }
}

const UPDATE_COLUMNS = COLUMNS.filter((c) => c !== 'platform' && c !== 'external_id')

// 27 columns × 300 rows = 8100 params, well under Postgres' 65535-per-query
// limit (see history.ts's CHUNK_SIZE for the same rationale).
const CHUNK_SIZE = 300

export async function upsertCurrentAuctions(auctions: Auction[], updatedAt: string): Promise<void> {
  const db = getPool()
  if (!db) return
  if (auctions.length === 0) return
  const rows = auctions.map((a) => auctionToCurrentRow(a, updatedAt))
  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await upsertChunk(db, rows.slice(i, i + CHUNK_SIZE))
    }
  } catch (err) {
    console.warn(`[current-auctions] upsert failed: ${(err as Error).message}`)
  }
}

async function upsertChunk(db: Pool, rows: CurrentAuctionRow[]): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const row of rows) {
    const placeholders = COLUMNS.map((_, i) => `$${values.length + i + 1}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(...COLUMNS.map((col) => row[col]))
  }
  const conflictSet = UPDATE_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')
  const sql = `
    INSERT INTO auctions (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
    ON CONFLICT (platform, external_id) DO UPDATE SET ${conflictSet}
  `
  await db.query(sql, values)
}
