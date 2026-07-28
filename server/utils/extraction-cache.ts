// Persistent cache of extracted structured fields (property type + sizes +
// WP-1/WP-2 fields) keyed by `${platform}:${externalId}`. Populated by the
// enrich task; the /api/auctions overlay reads it read-only so requests never
// block on extraction.
//
// Entries are keyed by auction identity, but the enrich task also stores the
// document-set hash/version that produced them. If the portal later adds,
// updates or withdraws a document, enrich writes a fresh entry from the new
// valid set instead of carrying forward stale document-derived facts.
//
// WP-3: Postgres (`extraction_cache` table) is the sole persistent store —
// no local JSON file. Since this runs as a single Nitro instance, the full
// table is loaded into an in-process cache on first read; every read for the
// rest of the process's lifetime (enrich task and API requests alike) is
// then served from memory, no round-trip. write* upserts only the entries
// it's given — the caller (the enrich task's `dirty` tracking) decides what
// actually changed since the last flush, so a run never re-upserts its whole
// cache on every flush. No-op without a configured pool, same
// graceful-degrade as current-auctions.ts/raw-archive.ts.

import type { Pool } from 'pg'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from './db'
import { cacheKey } from './verkehrswert-cache'
import { normalizePhoto, sortCuratedPhotos } from '~/lib/photo'

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
    // Normalize on read: older cache rows hold bare filename strings, newer
    // ones CuratedPhoto objects (see lib/photo.ts). Expose the normalized array
    // through `a.extraction` too, so consumers never see raw legacy strings
    // behind the `CuratedPhoto[]` type. Sorted by the LLM's own curation
    // (real photo vs. Energieausweis/plan/other) rather than pipeline order,
    // so `photos[0]` below is the best thumbnail candidate across every
    // platform, not just whichever page/file the crawler or pdfimages
    // happened to return first.
    const photos = sortCuratedPhotos((hit.photos ?? []).map(normalizePhoto))
    a.extraction = photos.length > 0 ? { ...hit, photos } : hit
    // WP-3: zvg-portal/DE has no structural Verkehrswert source (unlike
    // AT-Edikte/Biddit, whose overlay runs before this and already set
    // a.marketValueEur — see verkehrswert-cache.ts) — the LLM-extracted value
    // only fills in when nothing else has set one, never overwrites a
    // structurally known value. `hit.marketValueEur` is extracted in the
    // auction's native currency (see llm.ts), not converted — only safe to
    // apply here for EUR-native platforms (a.currency unset); everywhere else
    // it would silently misrepresent a foreign-currency figure as EUR.
    if (a.currency == null && a.marketValueEur == null && hit.marketValueEur != null) {
      a.marketValueEur = hit.marketValueEur
      a.marketValueText = hit.marketValueText ?? null
    }
    if (photos.length === 0) continue
    if (!a.thumbnailUrl) {
      a.thumbnailUrl = `/api/auction-image/${a.platform}/${a.externalId}/${photos[0]!.file}`
    }
    if (a.photoCount < photos.length) a.photoCount = photos.length
  }
}

// Memoized for the process's lifetime: the enrich task and every API request
// share this same object, so a mutation (writeExtractionCache below) is
// immediately visible everywhere without re-querying Postgres. Reset to null
// on a failed load so the next call retries instead of caching the failure.
let cachePromise: Promise<ExtractionCache> | null = null

export async function readExtractionCache(): Promise<ExtractionCache> {
  if (!cachePromise) cachePromise = loadExtractionCache()
  try {
    return await cachePromise
  } catch (err) {
    console.warn(`[extraction-cache] read failed: ${(err as Error).message}`)
    cachePromise = null
    return {}
  }
}

async function loadExtractionCache(): Promise<ExtractionCache> {
  const db = getPool()
  if (!db) return {}
  const { rows } = await db.query<{ platform: string; external_id: string; extraction: AuctionExtraction }>(
    'SELECT platform, external_id, extraction FROM extraction_cache',
  )
  const cache: ExtractionCache = {}
  for (const row of rows) {
    cache[cacheKey(row.platform, row.external_id)] = row.extraction
  }
  return cache
}

/**
 * Persist `entries` to Postgres and merge them into the in-process cache.
 * `entries` is expected to be only the keys that changed since the last
 * flush (see the enrich task's `dirty` tracking) — passing the whole cache
 * on every call would re-upsert unchanged rows and grow with every flush.
 */
/**
 * Returns whether the Postgres write succeeded, so the caller (the enrich
 * task's `dirty` tracking) can re-merge a failed batch for retry on the next
 * flush instead of silently losing it.
 */
export async function writeExtractionCache(entries: ExtractionCache): Promise<boolean> {
  const cache = await readExtractionCache()
  Object.assign(cache, entries)
  return writeExtractionCacheToDb(entries)
}

// 3 params per row (platform, external_id, extraction) × 5000 rows = 15000
// params, well under Postgres' 65535-per-query limit (see history.ts's
// CHUNK_SIZE for the same rationale).
const CHUNK_SIZE = 5000

async function writeExtractionCacheToDb(entries: ExtractionCache): Promise<boolean> {
  const db = getPool()
  if (!db) return true
  const keys = Object.keys(entries)
  if (keys.length === 0) return true
  try {
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      await upsertChunk(db, keys.slice(i, i + CHUNK_SIZE), entries)
    }
    return true
  } catch (err) {
    console.warn(`[extraction-cache] upsert failed: ${(err as Error).message}`)
    return false
  }
}

async function upsertChunk(db: Pool, keys: string[], entries: ExtractionCache): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const key of keys) {
    const separator = key.indexOf(':')
    const platform = key.slice(0, separator)
    const externalId = key.slice(separator + 1)
    const placeholders = [1, 2, 3].map((n) => `$${values.length + n}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(platform, externalId, JSON.stringify(entries[key]))
  }
  await db.query(
    `
    INSERT INTO extraction_cache (platform, external_id, extraction) VALUES ${tuples.join(', ')}
    ON CONFLICT (platform, external_id) DO UPDATE SET extraction = EXCLUDED.extraction, updated_at = now()
    `,
    values,
  )
}
