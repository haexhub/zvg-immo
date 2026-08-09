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

export async function readLocationEnrichmentCache(): Promise<LocationEnrichmentCache> {
  if (!cachePromise) cachePromise = loadLocationEnrichmentCache()
  try {
    return await cachePromise
  } catch (err) {
    console.warn(`[location-enrichment] read failed: ${(err as Error).message}`)
    cachePromise = null
    return {}
  }
}

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
  if (!db) return null
  try {
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
  } catch (err) {
    console.warn(`[location-enrichment] detail read failed: ${(err as Error).message}`)
    return null
  }
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
  const cache = await readLocationEnrichmentCache()
  Object.assign(cache, entries)
  for (const [key, entry] of Object.entries(entries)) cacheDetail(key, entry)
  return writeLocationEnrichmentCacheToDb(entries)
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
