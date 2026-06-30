// Persists the enrich task's final view of every crawled auction (already
// decorated with extraction + Verkehrswert overlays) to disk so the detail
// page can serve a shareable URL without re-crawling. Staleness is bounded by
// the enrich task interval (cron `30 */6 * * *`) — fresh enough for a
// listing whose key data doesn't change once published.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Auction } from '~/types/auction'
import { cacheKey } from './verkehrswert-cache'

const SNAPSHOT_PATH = join(process.cwd(), '.cache_zvg', 'auctions.json')

export type AuctionSnapshot = Record<string, Auction>

export async function readAuctionSnapshot(): Promise<AuctionSnapshot> {
  let buf: string
  try {
    buf = await readFile(SNAPSHOT_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.warn(`[auction-snapshot] failed to read: ${(err as Error).message}`)
    return {}
  }
  try {
    const parsed = JSON.parse(buf) as unknown
    if (parsed && typeof parsed === 'object') return parsed as AuctionSnapshot
  } catch (err) {
    console.warn(`[auction-snapshot] corrupt JSON: ${(err as Error).message}`)
  }
  return {}
}

export async function writeAuctionSnapshot(auctions: Auction[]): Promise<void> {
  const map: AuctionSnapshot = {}
  for (const a of auctions) {
    map[cacheKey(a.platform, a.zvgId)] = a
  }
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
  const tmp = `${SNAPSHOT_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(map))
  await rename(tmp, SNAPSHOT_PATH)
}
