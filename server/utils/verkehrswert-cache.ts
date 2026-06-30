// Persistent disk cache of detail-page Verkehrswerte for platforms that don't
// surface the value on their listing page (currently: AT-Edikte; BOE could be
// added analogously). The cache is populated by the nightly geocode task —
// API requests are read-only so they never block on detail fetches.
//
// Schätzwerte are essentially immutable per auction once published, so we use
// first-write-wins semantics with no TTL. Entries whose detail page lacked a
// Schätzwert row are stored as null to suppress re-fetching on every nightly run.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'verkehrswert.json')

export interface VerkehrswertEntry {
  verkehrswertEur: number | null
  verkehrswertText: string | null
}

export type VerkehrswertCache = Record<string, VerkehrswertEntry>

export function cacheKey(platform: string, zvgId: string): string {
  return `${platform}:${zvgId}`
}

export async function readVerkehrswertCache(): Promise<VerkehrswertCache> {
  try {
    const buf = await readFile(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(buf) as unknown
    if (parsed && typeof parsed === 'object') return parsed as VerkehrswertCache
  } catch {
    // miss → empty cache
  }
  return {}
}

export async function writeVerkehrswertCache(cache: VerkehrswertCache): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  // Atomic write: tmp file + rename so a crash mid-write can't truncate the
  // cache to an unparseable state.
  const tmp = `${CACHE_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(cache))
  await rename(tmp, CACHE_PATH)
}
