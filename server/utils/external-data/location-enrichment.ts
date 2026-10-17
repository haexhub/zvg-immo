import type { Pool } from 'pg'
import type { LocationEnrichment } from '~/types/auction'
import { getPool } from '../db'
import { cacheKey } from '../verkehrswert-cache'

export type LocationEnrichmentCache = Record<string, LocationEnrichment>

let cachePromise: Promise<LocationEnrichmentCache> | null = null
const detailCache = new Map<string, LocationEnrichment>()
const MAX_DETAIL_CACHE_ENTRIES = 500

function cacheDetail(key: string, enrichment: LocationEnrichment): void {
  // Map insertion order gives us a tiny bounded LRU without coupling detail
  // reads to the batch cache (which deliberately materializes the whole table).
  detailCache.delete(key)
  detailCache.set(key, enrichment)
  if (detailCache.size > MAX_DETAIL_CACHE_ENTRIES) detailCache.delete(detailCache.keys().next().value!)
}

export function invalidateLocationEnrichmentCache(): void {
  cachePromise = null
  detailCache.clear()
}

/** Per auction, just what choosing the next batch needs. */
export interface LocationEnrichmentStaleness {
  checkedAt: string
  /** `locationContext.source.id` of the stored entry, null when it has none. */
  locationContextSourceId: string | null
}

export function toLocationEnrichmentStaleness(entry: LocationEnrichment): LocationEnrichmentStaleness {
  return { checkedAt: entry.checkedAt, locationContextSourceId: entry.locationContext?.source.id ?? null }
}

/**
 * When each auction was last checked and where its location context came from —
 * all the batch selection reads of the stored enrichment. Two columns instead of
 * readLocationEnrichmentCache: that table holds ~800 MB of JSON (the OSM
 * location context is ~23 KB per auction), and holding it to look at two fields
 * made every 15-minute run push the app towards 1.5 GB.
 *
 * Throws on a failed read for the same reason as the full-table read: an empty
 * stand-in would make the run treat every auction as new.
 */
export async function readLocationEnrichmentStaleness(): Promise<Map<string, LocationEnrichmentStaleness>> {
  const db = getPool()
  if (!db) {
    // No database: memory is the only store (see writeLocationEnrichmentCache).
    const memory = (await cachePromise?.catch(() => null)) ?? Object.fromEntries(detailCache)
    return new Map(Object.entries(memory).map(([key, entry]) => [key, toLocationEnrichmentStaleness(entry)]))
  }
  try {
    const { rows } = await db.query<{
      platform: string
      external_id: string
      checked_at: string | Date
      checked_at_json: string | null
      location_context_source: string | null
    }>(
      `SELECT platform, external_id, checked_at,
              enrichment ->> 'checkedAt' AS checked_at_json,
              enrichment #>> '{locationContext,source,id}' AS location_context_source
       FROM location_enrichment`,
    )
    return new Map(rows.map((row) => [
      cacheKey(row.platform, row.external_id),
      // Same precedence as fromRow: the checkedAt inside the document wins.
      { checkedAt: normalizeIso(row.checked_at_json ?? row.checked_at), locationContextSourceId: row.location_context_source },
    ]))
  } catch (err) {
    throw new Error(`location_enrichment read failed: ${(err as Error).message}`, { cause: err })
  }
}

/** Throws on a failed read: an empty stand-in would make the enrichment run
 *  treat every auction as new and overwrite its stored results with null.
 *  Materializes the whole table (~800 MB of JSON) — tasks use
 *  readLocationEnrichmentStaleness / readLocationEnrichment instead. */
export async function readLocationEnrichmentCache(): Promise<LocationEnrichmentCache> {
  if (!cachePromise) cachePromise = loadLocationEnrichmentCache()
  try {
    return await cachePromise
  } catch (err) {
    cachePromise = null
    throw new Error(`location_enrichment read failed: ${(err as Error).message}`, { cause: err })
  }
}

/** Throws on a failed read for the same reason as the full-table read; the
 *  detail API decides itself whether to degrade to null. */

export async function readLocationEnrichment(
  platform: string,
  externalId: string,
): Promise<LocationEnrichment | null> {
  const key = cacheKey(platform, externalId)
  const cached = detailCache.get(key)
  if (cached) {
    cacheDetail(key, cached)
    return cached
  }
  const db = getPool()
  if (!db) {
    const memory = await cachePromise?.catch(() => null)
    const entry = memory?.[key]
    if (entry) cacheDetail(key, entry)
    return entry ?? null
  }
  const { rows } = await db.query<LocationEnrichmentRow>(
    `SELECT platform, external_id, enrichment, checked_at
     FROM location_enrichment
     WHERE platform = $1 AND external_id = $2`,
    [platform, externalId],
  )
  const row = rows[0]
  if (!row) return null
  const enrichment = fromRow(row)
  cacheDetail(key, enrichment)
  return enrichment
}

interface LocationEnrichmentRow {
  platform: string
  external_id: string
  enrichment: LocationEnrichment
  checked_at: string | Date
}

function fromRow(row: LocationEnrichmentRow): LocationEnrichment {
  return {
    ...row.enrichment,
    platform: row.platform,
    externalId: row.external_id,
    checkedAt: normalizeIso(row.enrichment.checkedAt ?? row.checked_at),
  }
}

async function loadLocationEnrichmentCache(): Promise<LocationEnrichmentCache> {
  const db = getPool()
  if (!db) return {}
  const { rows } = await db.query<LocationEnrichmentRow>('SELECT platform, external_id, enrichment, checked_at FROM location_enrichment')
  const cache: LocationEnrichmentCache = {}
  for (const row of rows) {
    const key = cacheKey(row.platform, row.external_id)
    cache[key] = fromRow(row)
  }
  return cache
}

export async function writeLocationEnrichmentCache(
  entries: LocationEnrichmentCache,
): Promise<boolean> {
  // Memory follows the database, never leads it: a failed upsert must leave
  // the old checkedAt in place so orderByStaleness retries the auction, and
  // detail reads must not serve data Postgres never stored.
  if (!(await writeLocationEnrichmentCacheToDb(entries))) return false
  // Only patch a full-table cache that is loaded or loading; one that isn't
  // will read this row from Postgres. Without a pool memory is the only store.
  if (!cachePromise && !getPool()) cachePromise = Promise.resolve({})
  const cache = await cachePromise?.catch(() => null)
  if (cache) Object.assign(cache, entries)
  for (const [key, entry] of Object.entries(entries)) cacheDetail(key, entry)
  return true
}

const CHUNK_SIZE = 1000

async function writeLocationEnrichmentCacheToDb(entries: LocationEnrichmentCache): Promise<boolean> {
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
    console.warn(`[location-enrichment] upsert failed: ${(err as Error).message}`)
    return false
  }
}

async function upsertChunk(
  db: Pool,
  keys: string[],
  entries: LocationEnrichmentCache,
): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const key of keys) {
    const entry = entries[key]
    if (!entry) continue
    const separator = key.indexOf(':')
    const platform = key.slice(0, separator)
    const externalId = key.slice(separator + 1)
    const placeholders = [1, 2, 3, 4].map((n) => `$${values.length + n}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(platform, externalId, JSON.stringify(entry), entry.checkedAt)
  }
  if (tuples.length === 0) return
  await db.query(
    `
    INSERT INTO location_enrichment (platform, external_id, enrichment, checked_at)
    VALUES ${tuples.join(', ')}
    ON CONFLICT (platform, external_id) DO UPDATE
      SET enrichment = EXCLUDED.enrichment, checked_at = EXCLUDED.checked_at, updated_at = now()
    `,
    values,
  )
}

function normalizeIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}
