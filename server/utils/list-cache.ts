import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CrawlResult } from '~/types/auction'
import { MULTI_PLATFORM, SCOPE_PARAM_RE } from '~/lib/auction-constants'
import { isCountryEnabled } from '../crawlers/registry'
import { writeJsonCache } from './json-cache'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'list')

function assertCacheSegment(name: string, value: string): void {
  if (!SCOPE_PARAM_RE.test(value)) {
    throw new Error(`Invalid list-cache ${name}: ${value}`)
  }
}

function cacheFile(country: string, region: string): string {
  assertCacheSegment('country', country)
  assertCacheSegment('region', region)
  return join(CACHE_DIR, `${country}-${region}.json`)
}

export async function readListCache(country: string, region: string): Promise<CrawlResult | null> {
  // A paused country's on-disk cache from before the pause must stop being
  // served, not just stop being refreshed — otherwise stale non-enabled-
  // country listings would keep showing up for anyone who still requests
  // them by URL/saved search (see server/crawlers/registry.ts's
  // ENABLED_COUNTRIES). Treat it like a cache miss.
  if (!isCountryEnabled(country)) return null
  try {
    const raw = await readFile(cacheFile(country, region), 'utf8')
    return JSON.parse(raw) as CrawlResult
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn(`[list-cache] read ${country}/${region}: ${(err as Error).message}`)
    return null
  }
}

export async function writeListCache(
  country: string,
  region: string,
  result: CrawlResult,
): Promise<void> {
  await writeJsonCache(cacheFile(country, region), result)
}

/**
 * Age (ms) of the most recently written list-cache file, or null when the
 * cache is empty/absent. The boot-time refresh/enrich plugins use this to skip
 * a full re-crawl when a restart (crash or podman auto-update) lands on an
 * already-warm cache — repeated cold crawls of every upstream portal otherwise
 * risk getting the server IP banned.
 */
export async function listCacheAgeMs(): Promise<number | null> {
  let entries: string[]
  try {
    entries = await readdir(CACHE_DIR)
  } catch {
    return null
  }
  const files = entries.filter((f) => f.endsWith('.json'))
  if (files.length === 0) return null
  let newest = 0
  for (const file of files) {
    try {
      const s = await stat(join(CACHE_DIR, file))
      if (s.mtimeMs > newest) newest = s.mtimeMs
    } catch {
      // skip unreadable entries
    }
  }
  if (newest === 0) return null
  return Date.now() - newest
}

/**
 * Age (ms) of one region's list-cache file, or null when it doesn't exist yet.
 * The hourly background refresh uses this to skip regions crawled recently
 * enough for their portal's cadence (see server/crawlers/crawl-cadence.ts).
 */
export async function regionListCacheAgeMs(country: string, region: string): Promise<number | null> {
  try {
    const s = await stat(cacheFile(country, region))
    return Date.now() - s.mtimeMs
  } catch {
    return null
  }
}

/**
 * Merge all cached region results, optionally filtered to one country.
 * Returns null when the cache directory doesn't exist or is empty.
 */
export async function readMergedListCache(country?: string): Promise<CrawlResult | null> {
  if (country) assertCacheSegment('country', country)
  let entries: string[]
  try {
    entries = await readdir(CACHE_DIR)
  } catch {
    return null
  }
  const prefix = country ? `${country}-` : ''
  const files = entries.filter((f) => {
    if (!f.endsWith('.json') || (prefix && !f.startsWith(prefix))) return false
    // Same pause-must-hide-not-just-stop-refreshing rationale as readListCache.
    const fileCountry = f.slice(0, f.indexOf('-'))
    return isCountryEnabled(fileCountry)
  })
  if (files.length === 0) return null

  const results: CrawlResult[] = []
  for (const file of files) {
    try {
      const raw = await readFile(join(CACHE_DIR, file), 'utf8')
      results.push(JSON.parse(raw) as CrawlResult)
    } catch {
      // skip corrupt files
    }
  }
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
}
