// Persistent disk cache of extracted structured fields (property type + sizes)
// keyed by `${platform}:${zvgId}`. Populated by the enrich task; the
// /api/auctions overlay reads it read-only so requests never block on
// extraction. Mirrors verkehrswert-cache.ts (same `${platform}:${zvgId}` key
// — via the shared cacheKey helper — and the same atomic-write and
// resilient-read semantics).
//
// First-write-wins, no TTL: a listing's text/documents don't change once
// published. A later run may still re-process entries whose `confidence` is
// 'low' to upgrade them with the LLM (see the enrich task).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AuctionExtraction } from '~/types/auction'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'extraction.json')

export type ExtractionCache = Record<string, AuctionExtraction>

export async function readExtractionCache(): Promise<ExtractionCache> {
  let buf: string
  try {
    buf = await readFile(CACHE_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.warn(
      `[extraction-cache] failed to read ${CACHE_PATH}: ${(err as Error).message}`,
    )
    return {}
  }
  try {
    const parsed = JSON.parse(buf) as unknown
    if (parsed && typeof parsed === 'object') return parsed as ExtractionCache
  } catch (err) {
    console.warn(
      `[extraction-cache] corrupt JSON at ${CACHE_PATH}: ${(err as Error).message}`,
    )
  }
  return {}
}

export async function writeExtractionCache(cache: ExtractionCache): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  // Atomic write: tmp file + rename so a crash mid-write can't truncate the
  // cache to an unparseable state.
  const tmp = `${CACHE_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(cache))
  await rename(tmp, CACHE_PATH)
}
