// Disk cache for AI-generated German summaries, keyed by `${platform}:${externalId}`.
// Written by the /api/auction/:platform/:id/summary endpoint on first request.
// Atomic-write semantics match extraction-cache.ts and verkehrswert-cache.ts.

import { join } from 'node:path'
import { readJsonCache, writeJsonCache } from './json-cache'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'summary.json')

export interface AuctionSummary {
  text: string
  at: string
}

export type SummaryCache = Record<string, AuctionSummary>

export async function readSummaryCache(): Promise<SummaryCache> {
  return readJsonCache<SummaryCache>(CACHE_PATH, () => ({}), 'summary-cache')
}

export async function writeSummaryCache(cache: SummaryCache): Promise<void> {
  await writeJsonCache(CACHE_PATH, cache)
}
