// Persistent disk cache of detail-page Verkehrswerte for platforms that don't
// surface the value on their listing page (currently: AT-Edikte; BOE could be
// added analogously). The cache is populated by the nightly geocode task —
// API requests are read-only so they never block on detail fetches.
//
// Schätzwerte are essentially immutable per auction once published, so we use
// first-write-wins semantics with no TTL. Entries whose detail page lacked a
// Schätzwert row are stored as null to suppress re-fetching on every nightly run.

import { join } from 'node:path'
import { readJsonCache, writeJsonCache } from './json-cache'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'verkehrswert.json')

export interface VerkehrswertEntry {
  marketValueEur: number | null
  marketValueText: string | null
  /** Set on null entries written after the biddit startingPrice fallback
   *  existed — marks "re-checked, genuinely no price" so the geocode task's
   *  one-time null backfill doesn't refetch the same lot on every run. */
  retried?: boolean
}

export type VerkehrswertCache = Record<string, VerkehrswertEntry>

export function cacheKey(platform: string, externalId: string): string {
  return `${platform}:${externalId}`
}

// Field-name-only migration (WP-1): entries written before this rename still
// have the old `verkehrswertEur`/`verkehrswertText` keys on disk. Remap them
// on read so existing cache entries aren't silently orphaned (which would
// also stop them from ever being re-fetched, since the geocode task's
// toFetch filter only checks key *existence*, not field shape).
function migrateEntry(raw: unknown): VerkehrswertEntry {
  const e = raw as Record<string, unknown>
  return {
    marketValueEur: (e.marketValueEur ?? e.verkehrswertEur ?? null) as number | null,
    marketValueText: (e.marketValueText ?? e.verkehrswertText ?? null) as string | null,
    ...(e.retried ? { retried: true } : {}),
  }
}

export async function readVerkehrswertCache(): Promise<VerkehrswertCache> {
  const cache = await readJsonCache<Record<string, unknown>>(CACHE_PATH, () => ({}), 'verkehrswert-cache')
  const migrated: VerkehrswertCache = {}
  for (const [key, entry] of Object.entries(cache)) migrated[key] = migrateEntry(entry)
  return migrated
}

export async function writeVerkehrswertCache(cache: VerkehrswertCache): Promise<void> {
  await writeJsonCache(CACHE_PATH, cache)
}
