// Persistent cache of extracted structured fields (property type + sizes +
// WP-1/WP-2 fields) keyed by `${platform}:${externalId}`. Populated by the
// enrich task; the /api/auctions overlay reads it read-only so requests never
// block on extraction. Mirrors verkehrswert-cache.ts (same
// `${platform}:${externalId}` key — via the shared cacheKey helper — and the
// same atomic-write and resilient-read semantics).
//
// First-write-wins, no TTL: a listing's text/documents don't change once
// published. A later run may still re-process entries whose `confidence` is
// 'low' to upgrade them with the LLM (see the enrich task).
//
// WP-3: Postgres (`extraction_cache` table) is the durable source — a local
// volume loss must not force a full LLM re-run. The local JSON file stays the
// primary fast path: readExtractionCache runs on every /api/auctions request
// (via overlayExtraction), so it only falls back to a Postgres scan when the
// local file is empty — the volume-loss case. A healthy box never round-trips
// to the DB on read. No-op without a configured pool, same graceful-degrade as
// current-auctions.ts/raw-archive.ts.

import { join } from 'node:path'
import type { Pool } from 'pg'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from './db'
import { readJsonCache, writeJsonCache } from './json-cache'
import { cacheKey } from './verkehrswert-cache'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'extraction.json')

export type ExtractionCache = Record<string, AuctionExtraction>

/**
 * Apply the extraction cache to a set of auctions (mutates in place). Synthesises
 * a `thumbnailUrl` and bumps `photoCount` from `extraction.photos` when the
 * listing didn't bring its own photo attachment. Shared by the /api/auctions
 * overlay and the enrich-task snapshot writer so they stay consistent.
 */
export function applyExtractionToAuctions(auctions: Auction[], cache: ExtractionCache): void {
  for (const a of auctions) {
    const hit = cache[cacheKey(a.platform, a.externalId)]
    if (!hit) continue
    a.extraction = hit
    const photos = hit.photos ?? []
    if (photos.length === 0) continue
    if (!a.thumbnailUrl) {
      a.thumbnailUrl = `/api/auction-image/${a.platform}/${a.externalId}/${photos[0]}`
    }
    if (a.photoCount < photos.length) a.photoCount = photos.length
  }
}

export async function readExtractionCache(): Promise<ExtractionCache> {
  const local = await readJsonCache<ExtractionCache>(CACHE_PATH, () => ({}), 'extraction-cache')
  // Fast path: on a healthy box the local file is complete, so serve it without
  // touching Postgres — this runs on every /api/auctions request. Only when the
  // local volume is gone (empty file) do we rebuild from the durable DB copy.
  if (Object.keys(local).length > 0) return local
  return readExtractionCacheFromDb()
}

export async function writeExtractionCache(cache: ExtractionCache): Promise<void> {
  await writeJsonCache(CACHE_PATH, cache)
  await writeExtractionCacheToDb(cache)
}

async function readExtractionCacheFromDb(): Promise<ExtractionCache> {
  const db = getPool()
  if (!db) return {}
  try {
    const { rows } = await db.query<{ platform: string; external_id: string; extraction: AuctionExtraction }>(
      'SELECT platform, external_id, extraction FROM extraction_cache',
    )
    const cache: ExtractionCache = {}
    for (const row of rows) {
      cache[cacheKey(row.platform, row.external_id)] = row.extraction
    }
    return cache
  } catch (err) {
    console.warn(`[extraction-cache] read failed: ${(err as Error).message}`)
    return {}
  }
}

// 3 params per row (platform, external_id, extraction) × 5000 rows = 15000
// params, well under Postgres' 65535-per-query limit (see history.ts's
// CHUNK_SIZE for the same rationale).
const CHUNK_SIZE = 5000

async function writeExtractionCacheToDb(cache: ExtractionCache): Promise<void> {
  const db = getPool()
  if (!db) return
  const keys = Object.keys(cache)
  if (keys.length === 0) return
  try {
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      await upsertChunk(db, keys.slice(i, i + CHUNK_SIZE), cache)
    }
  } catch (err) {
    console.warn(`[extraction-cache] upsert failed: ${(err as Error).message}`)
  }
}

async function upsertChunk(db: Pool, keys: string[], cache: ExtractionCache): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const key of keys) {
    const separator = key.indexOf(':')
    const platform = key.slice(0, separator)
    const externalId = key.slice(separator + 1)
    const placeholders = [1, 2, 3].map((n) => `$${values.length + n}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(platform, externalId, JSON.stringify(cache[key]))
  }
  await db.query(
    `
    INSERT INTO extraction_cache (platform, external_id, extraction) VALUES ${tuples.join(', ')}
    ON CONFLICT (platform, external_id) DO UPDATE SET extraction = EXCLUDED.extraction, updated_at = now()
    `,
    values,
  )
}
