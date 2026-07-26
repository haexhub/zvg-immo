// Persistent, per-region cache of list-crawl results in Postgres (`list_cache`
// table) — WP-5: Postgres is the sole serving store, no local JSON file.
// Written by the refresh task at each region's existing portal cadence
// (crawl-cadence.ts) and by the /api/auctions cold-start warming path, so
// list freshness is unchanged from the JSON-file era. No-op without a
// configured pool, same graceful-degrade as current-auctions.ts/
// extraction-cache.ts: without Postgres, /api/auctions falls back to its
// existing live-crawl path (the same thing that happened on a cold/missing
// file before).

import type { CrawlResult } from '~/types/auction'
import { MULTI_PLATFORM } from '~/lib/auction-constants'
import { ensureEnabledCountriesLoaded, isCountryEnabled } from '../crawlers/registry'
import { getPool } from './db'

const DEFAULT_LIST_CACHE_VERSION = 1
const COUNTRY_LIST_CACHE_VERSION: Record<string, number> = {
  // v2: Kronofogden crawler started paginating search results and added the
  // separate commercial-property source. Older rows only contain the first
  // residential result page and must be treated as stale after deploy.
  se: 2,
}

function expectedListCacheVersion(country: string): number {
  return COUNTRY_LIST_CACHE_VERSION[country.toLowerCase()] ?? DEFAULT_LIST_CACHE_VERSION
}

function storedListCacheVersion(result: CrawlResult): number {
  return storedListCacheVersionValue(result.listCacheVersion)
}

function storedListCacheVersionValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return DEFAULT_LIST_CACHE_VERSION
}

function isFreshListCacheResult(country: string, result: CrawlResult): boolean {
  return isFreshListCacheVersion(country, storedListCacheVersion(result))
}

function isFreshListCacheVersion(country: string, version: unknown): boolean {
  return storedListCacheVersionValue(version) === expectedListCacheVersion(country)
}

function versionedResult(country: string, result: CrawlResult): CrawlResult {
  return { ...result, listCacheVersion: expectedListCacheVersion(country) }
}

export async function readListCache(country: string, region: string): Promise<CrawlResult | null> {
  await ensureEnabledCountriesLoaded()
  // A paused country's cached row must stop being served, not just stop being
  // refreshed — otherwise stale non-enabled-country listings would keep
  // showing up for anyone who still requests them by URL/saved search (see
  // server/crawlers/registry.ts's ENABLED_COUNTRIES).
  if (!isCountryEnabled(country)) return null
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = await db.query<{ result: CrawlResult }>(
      'SELECT result FROM list_cache WHERE country = $1 AND region = $2',
      [country, region],
    )
    const result = rows[0]?.result ?? null
    return result && isFreshListCacheResult(country, result) ? result : null
  } catch (err) {
    console.warn(`[list-cache] read ${country}/${region}: ${(err as Error).message}`)
    return null
  }
}

export async function writeListCache(
  country: string,
  region: string,
  result: CrawlResult,
): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query(
      `INSERT INTO list_cache (country, region, result, fetched_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (country, region) DO UPDATE SET result = EXCLUDED.result, fetched_at = EXCLUDED.fetched_at`,
      [country, region, JSON.stringify(versionedResult(country, result)), result.fetchedAt],
    )
  } catch (err) {
    console.warn(`[list-cache] write ${country}/${region}: ${(err as Error).message}`)
  }
}

/**
 * Age (ms) of the most recently written region, or null when the cache is
 * empty/unconfigured. The boot-time refresh/enrich plugins use this to skip a
 * full re-crawl when a restart (crash or podman auto-update) lands on an
 * already-warm cache — repeated cold crawls of every upstream portal otherwise
 * risk getting the server IP banned.
 */
export async function listCacheAgeMs(): Promise<number | null> {
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = await db.query<{ country: string; list_cache_version: string | null; fetched_at: string }>(
      `SELECT country, result->>'listCacheVersion' AS list_cache_version, fetched_at
       FROM list_cache`,
    )
    if (rows.some((row) => isCountryEnabled(row.country) && !isFreshListCacheVersion(row.country, row.list_cache_version))) {
      return null
    }
    const newest = rows
      .filter((row) => isCountryEnabled(row.country))
      .reduce((latest, row) => (row.fetched_at > latest ? row.fetched_at : latest), '')
    return newest ? Date.now() - new Date(newest).getTime() : null
  } catch (err) {
    console.warn(`[list-cache] age check: ${(err as Error).message}`)
    return null
  }
}

/**
 * Age (ms) of one region's cached row, or null when it doesn't exist yet.
 * The hourly background refresh uses this to skip regions crawled recently
 * enough for their portal's cadence (see server/crawlers/crawl-cadence.ts).
 */
export async function regionListCacheAgeMs(country: string, region: string): Promise<number | null> {
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = await db.query<{ fetched_at: string; list_cache_version: string | null }>(
      `SELECT fetched_at, result->>'listCacheVersion' AS list_cache_version
       FROM list_cache WHERE country = $1 AND region = $2`,
      [country, region],
    )
    const row = rows[0]
    if (row && !isFreshListCacheVersion(country, row.list_cache_version)) return null
    const fetchedAt = row?.fetched_at
    return fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : null
  } catch (err) {
    console.warn(`[list-cache] region age check ${country}/${region}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Merge all cached region results, optionally filtered to one country.
 * Returns null when the cache is empty/unconfigured.
 */
export async function readMergedListCache(country?: string): Promise<CrawlResult | null> {
  await ensureEnabledCountriesLoaded()
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = country
      ? await db.query<{ country: string; result: CrawlResult }>(
          'SELECT country, result FROM list_cache WHERE country = $1',
          [country],
        )
      : await db.query<{ country: string; result: CrawlResult }>(
          'SELECT country, result FROM list_cache',
        )
    // Same pause-must-hide-not-just-stop-refreshing rationale as readListCache.
    const results = rows
      .filter((r) => isCountryEnabled(r.country) && isFreshListCacheResult(r.country, r.result))
      .map((r) => r.result)
    if (results.length === 0) return null

    return {
      platform: MULTI_PLATFORM,
      source: [...new Set(results.map((r) => r.source))].join(', '),
      countries: [...new Set(results.flatMap((r) => r.countries))],
      regions: [...new Set(results.flatMap((r) => r.regions))],
      fetchedAt: results.reduce((latest, r) => (r.fetchedAt > latest ? r.fetchedAt : latest), ''),
      totalReported: null,
      auctions: results.flatMap((r) => r.auctions),
    }
  } catch (err) {
    console.warn(`[list-cache] merged read${country ? ` (${country})` : ''}: ${(err as Error).message}`)
    return null
  }
}
