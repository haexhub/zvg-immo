// Persists the enrich task's final view of every crawled auction (already
// decorated with extraction + Verkehrswert overlays) to disk so the detail
// page can serve a shareable URL without re-crawling. Staleness is bounded by
// the enrich task interval (cron `30 */6 * * *`) — fresh enough for a
// listing whose key data doesn't change once published.
//
// Detail fields (attachments/beschreibung/pdfUrl/…) come from enrichOne, which
// the enrich task runs only for auctions not yet in the extraction cache. On
// subsequent runs those fields are empty on the fresh crawl, so we merge with
// the previous snapshot to keep the enriched values from the first crawl.

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

/**
 * Fields populated by the crawlers' `enrichOne` — absent on the fresh listing
 * crawl. Preserved from the previous snapshot when the new auction has them
 * empty so a run that didn't re-enrich doesn't wipe out the detail data.
 */
function mergePreservedDetail(next: Auction, prev: Auction): Auction {
  if (next.attachments.length === 0 && prev.attachments.length > 0) {
    next.attachments = prev.attachments
  }
  if (next.beschreibung == null && prev.beschreibung != null) {
    next.beschreibung = prev.beschreibung
  }
  if (next.pdfUrl == null && prev.pdfUrl != null) {
    next.pdfUrl = prev.pdfUrl
    next.pdfUrlUpstream = prev.pdfUrlUpstream
  }
  if (next.fotoCount === 0 && prev.fotoCount > 0) {
    next.fotoCount = prev.fotoCount
  }
  if (next.thumbnailUrl == null && prev.thumbnailUrl != null) {
    next.thumbnailUrl = prev.thumbnailUrl
  }
  if (next.verkehrswertEur == null && prev.verkehrswertEur != null) {
    next.verkehrswertEur = prev.verkehrswertEur
    next.verkehrswertText = prev.verkehrswertText
  }
  return next
}

export async function writeAuctionSnapshot(auctions: Auction[]): Promise<void> {
  const previous = await readAuctionSnapshot()
  const map: AuctionSnapshot = {}
  for (const a of auctions) {
    const key = cacheKey(a.platform, a.zvgId)
    const prev = previous[key]
    map[key] = prev ? mergePreservedDetail(a, prev) : a
  }
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
  const tmp = `${SNAPSHOT_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(map))
  await rename(tmp, SNAPSHOT_PATH)
}
