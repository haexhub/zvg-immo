// Appends one row per auction to auction_observations (Postgres) on every
// `refresh` run — the append-only history the JSON list cache doesn't keep
// (list-cache.ts overwrites the previous run's snapshot). No-op when
// Postgres isn't configured (see server/utils/db.ts).

import type { Pool } from 'pg'
import type { Auction, CrawlResult } from '~/types/auction'
import { getPool } from './db'
import { applyExtractionToAuctions, readExtractionCache } from './extraction-cache'

const COLUMNS = [
  'captured_at',
  'platform',
  'country',
  'region',
  'zvg_id',
  'amtsgericht',
  'aktenzeichen',
  'objekt',
  'property_type',
  'land_area_sqm',
  'living_area_sqm',
  'rooms',
  'units',
  'verkehrswert_eur',
  'termin_iso',
  'aufgehoben',
] as const

export type ObservationRow = {
  captured_at: string
  platform: string
  country: string
  region: string
  zvg_id: string
  amtsgericht: string
  aktenzeichen: string
  objekt: string | null
  property_type: string | null
  land_area_sqm: number | null
  living_area_sqm: number | null
  rooms: number | null
  units: number | null
  verkehrswert_eur: number | null
  termin_iso: string | null
  aufgehoben: boolean
}

export function auctionToObservationRow(a: Auction, capturedAt: string): ObservationRow {
  return {
    captured_at: capturedAt,
    platform: a.platform,
    country: a.country,
    region: a.region,
    zvg_id: a.zvgId,
    amtsgericht: a.amtsgericht,
    aktenzeichen: a.aktenzeichen,
    objekt: a.objekt,
    property_type: a.extraction?.propertyType ?? null,
    land_area_sqm: a.extraction?.landAreaSqm ?? null,
    living_area_sqm: a.extraction?.livingAreaSqm ?? null,
    rooms: a.extraction?.rooms ?? null,
    units: a.extraction?.units ?? null,
    verkehrswert_eur: a.verkehrswertEur,
    termin_iso: a.terminIso,
    aufgehoben: a.aufgehoben,
  }
}

// Chunk size keeps well under Postgres' 65535-parameter-per-query limit
// (16 columns × 500 rows = 8000 params) while still batching efficiently.
const CHUNK_SIZE = 500

export async function recordObservations(result: CrawlResult, capturedAt: string): Promise<void> {
  const db = getPool()
  if (!db) return
  if (result.auctions.length === 0) return

  const cache = await readExtractionCache()
  applyExtractionToAuctions(result.auctions, cache)
  const rows = result.auctions.map((a) => auctionToObservationRow(a, capturedAt))

  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await insertChunk(db, rows.slice(i, i + CHUNK_SIZE))
    }
  } catch (err) {
    console.warn(`[history] insert failed: ${(err as Error).message}`)
  }
}

async function insertChunk(db: Pool, rows: ObservationRow[]): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const row of rows) {
    const placeholders = COLUMNS.map((_, i) => `$${values.length + i + 1}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(...COLUMNS.map((col) => row[col]))
  }
  const sql = `INSERT INTO auction_observations (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`
  await db.query(sql, values)
}
