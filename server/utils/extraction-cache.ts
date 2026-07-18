// Persistent disk cache of extracted structured fields (property type + sizes)
// keyed by `${platform}:${externalId}`. Populated by the enrich task; the
// /api/auctions overlay reads it read-only so requests never block on
// extraction. Mirrors verkehrswert-cache.ts (same `${platform}:${externalId}` key
// — via the shared cacheKey helper — and the same atomic-write and
// resilient-read semantics).
//
// First-write-wins, no TTL: a listing's text/documents don't change once
// published. A later run may still re-process entries whose `confidence` is
// 'low' to upgrade them with the LLM (see the enrich task).

import { join } from 'node:path'
import type { Auction, AuctionExtraction } from '~/types/auction'
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
  return readJsonCache<ExtractionCache>(CACHE_PATH, () => ({}), 'extraction-cache')
}

export async function writeExtractionCache(cache: ExtractionCache): Promise<void> {
  await writeJsonCache(CACHE_PATH, cache)
}
