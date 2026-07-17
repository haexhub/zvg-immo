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

import { randomUUID } from 'node:crypto'
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
 * Snapshot JSON is loaded untyped, so guard against malformed / legacy entries
 * where fields might be missing or the wrong shape.
 *
 * Exported for tests.
 */
export function mergePreservedDetail(next: Auction, prev: Auction): Auction {
  const prevAttachments = Array.isArray(prev.attachments) ? prev.attachments : []
  if (next.attachments.length === 0 && prevAttachments.length > 0) {
    next.attachments = prevAttachments
  }
  if (next.beschreibung == null && prev.beschreibung != null) {
    next.beschreibung = prev.beschreibung
  } else if (
    next.beschreibung != null &&
    prev.beschreibung != null &&
    prev.detailFetchedAt != null &&
    prev.beschreibung.startsWith(next.beschreibung)
  ) {
    // enrichOne extends the list text in place (e.g. LV appends Kadastra
    // lines), so the enriched beschreibung starts with the fresh list text.
    // A crawl that didn't re-enrich must not truncate it back down.
    next.beschreibung = prev.beschreibung
  }
  // `aktenzeichen` is typed as plain string but crawlers emit ''/null when a
  // re-crawl couldn't resolve it — restore the previously known value then.
  if (!next.aktenzeichen && prev.aktenzeichen) {
    next.aktenzeichen = prev.aktenzeichen
  }
  if (next.pdfUrl == null && prev.pdfUrl != null) {
    next.pdfUrl = prev.pdfUrl
    next.pdfUrlUpstream = prev.pdfUrlUpstream
  }
  if (next.fotoCount === 0 && typeof prev.fotoCount === 'number' && prev.fotoCount > 0) {
    next.fotoCount = prev.fotoCount
  }
  if (next.thumbnailUrl == null && prev.thumbnailUrl != null) {
    next.thumbnailUrl = prev.thumbnailUrl
  }
  if (next.verkehrswertEur == null && prev.verkehrswertEur != null) {
    next.verkehrswertEur = prev.verkehrswertEur
    next.verkehrswertText = prev.verkehrswertText
  }
  if (next.detailFetchedAt == null && prev.detailFetchedAt != null) {
    next.detailFetchedAt = prev.detailFetchedAt
  }
  if (next.sourceLivingAreaSqm == null && prev.sourceLivingAreaSqm != null) {
    next.sourceLivingAreaSqm = prev.sourceLivingAreaSqm
  }
  if (next.sourceLandAreaSqm == null && prev.sourceLandAreaSqm != null) {
    next.sourceLandAreaSqm = prev.sourceLandAreaSqm
  }
  if (next.sourceRooms == null && prev.sourceRooms != null) {
    next.sourceRooms = prev.sourceRooms
  }
  if ((next.photoUrls == null || next.photoUrls.length === 0) && Array.isArray(prev.photoUrls) && prev.photoUrls.length > 0) {
    next.photoUrls = prev.photoUrls
    // Crawlers keep fotoCount in sync with photoUrls (see types/auction.ts);
    // restoring the gallery without the count would leave e.g. fotoCount=1
    // from the list crawl next to a 5-image gallery.
    if (!(typeof next.fotoCount === 'number') || next.fotoCount < prev.photoUrls.length) {
      next.fotoCount = prev.photoUrls.length
    }
  }
  if (next.lat == null && prev.lat != null && prev.lng != null) {
    next.lat = prev.lat
    next.lng = prev.lng
  }
  return next
}

export async function writeAuctionSnapshot(auctions: Auction[]): Promise<void> {
  const previous = await readAuctionSnapshot()
  const map: AuctionSnapshot = {}
  const platformsSeen = new Set<string>()
  for (const a of auctions) {
    platformsSeen.add(a.platform)
    const key = cacheKey(a.platform, a.zvgId)
    const prev = previous[key]
    map[key] = prev ? mergePreservedDetail(a, prev) : a
  }
  // A platform that is entirely absent from this crawl most likely failed
  // (e.g. BOE captcha cooldown) — keep its previous entries instead of
  // dropping them and losing the enrichOne detail data for good. Deliberate
  // trade-off: a legitimately empty platform keeps stale entries, which is
  // better than permanent data loss during an outage.
  for (const [key, prev] of Object.entries(previous)) {
    const platform = key.split(':')[0]!
    if (!platformsSeen.has(platform)) map[key] = prev
  }
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
  const tmp = `${SNAPSHOT_PATH}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(map))
  await rename(tmp, SNAPSHOT_PATH)
}
