// Disk cache for AI-generated German summaries, keyed by `${platform}:${zvgId}`.
// Written by the /api/auction/:platform/:id/summary endpoint on first request.
// Atomic-write semantics match extraction-cache.ts and verkehrswert-cache.ts.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CACHE_PATH = join(process.cwd(), '.cache_zvg', 'summary.json')

export interface AuctionSummary {
  text: string
  at: string
}

export type SummaryCache = Record<string, AuctionSummary>

export async function readSummaryCache(): Promise<SummaryCache> {
  let buf: string
  try {
    buf = await readFile(CACHE_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.warn(`[summary-cache] read failed: ${(err as Error).message}`)
    return {}
  }
  try {
    const parsed = JSON.parse(buf) as unknown
    if (parsed && typeof parsed === 'object') return parsed as SummaryCache
  } catch (err) {
    console.warn(`[summary-cache] corrupt JSON: ${(err as Error).message}`)
  }
  return {}
}

export async function writeSummaryCache(cache: SummaryCache): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  const tmp = `${CACHE_PATH}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(cache))
  await rename(tmp, CACHE_PATH)
}
