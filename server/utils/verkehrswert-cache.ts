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
  verkehrswertEur: number | null
  verkehrswertText: string | null
  /** Set on null entries written after the biddit startingPrice fallback
   *  existed — marks "re-checked, genuinely no price" so the geocode task's
   *  one-time null backfill doesn't refetch the same lot on every run. */
  retried?: boolean
}

export type VerkehrswertCache = Record<string, VerkehrswertEntry>

export function cacheKey(platform: string, zvgId: string): string {
  return `${platform}:${zvgId}`
}

export async function readVerkehrswertCache(): Promise<VerkehrswertCache> {
  return readJsonCache<VerkehrswertCache>(CACHE_PATH, () => ({}), 'verkehrswert-cache')
}

export async function writeVerkehrswertCache(cache: VerkehrswertCache): Promise<void> {
  await writeJsonCache(CACHE_PATH, cache)
}
