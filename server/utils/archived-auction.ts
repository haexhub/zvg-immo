// Reads the archived `auction` snapshot that extraction (reprocess, admin
// trial, retries) works from.
//
// archiveAuction writes a listing-level snapshot on every crawl and a second,
// detail-enriched one (description, attachments, source* values) only when the
// enrich task fetches the detail page. The newest capture is therefore the
// listing snapshot as soon as a crawl ran after enrichment, and extraction
// from it saw only the title: the LLM got no description and returned (or
// merged) far less than the same model got from the enriched snapshot.
//
// So: keep the newest snapshot as the base (it carries the current bids,
// dates and cancellation state) and fill what it lacks from older snapshots
// that actually have detail data.

import type { Auction } from '~/types/auction'
import { downloadBlob, listDistinctCaptures } from '~/server/utils/storage-download'

/** Distinct snapshots inspected, newest first. Small JSON blobs; bounded so an
 *  auction that never had a description doesn't download its whole history on
 *  every run. */
export const SNAPSHOT_SCAN_LIMIT = 8

/** Parse one archived auction blob without allowing malformed data to abort a scan. */
function parseAuction(bytes: Buffer): Auction | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Auction
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** True once the snapshot carries something only the detail fetch provides.
 *  `detailFetchedAt` alone doesn't count: an enriched auction without any
 *  description/attachments has nothing to contribute. */
export function hasDetailData(auction: Auction): boolean {
  return (
    !!auction.description?.trim() ||
    (auction.attachments?.length ?? 0) > 0 ||
    auction.sourceLivingAreaSqm != null ||
    auction.sourceLandAreaSqm != null ||
    auction.sourceRooms != null
  )
}

/** `base` with the detail-owned fields it lacks taken from `detail`. List-level
 *  values the base already has (bids, dates, cancelled, ...) stay as they are. */
export function overlayDetailData(base: Auction, detail: Auction): Auction {
  const merged: Auction = { ...base }
  if (!merged.title?.trim() && detail.title?.trim()) merged.title = detail.title
  if (!merged.description?.trim()) merged.description = detail.description
  if (!(merged.attachments?.length)) merged.attachments = detail.attachments ?? []
  if (merged.sourceLivingAreaSqm == null) merged.sourceLivingAreaSqm = detail.sourceLivingAreaSqm
  if (merged.sourceLandAreaSqm == null) merged.sourceLandAreaSqm = detail.sourceLandAreaSqm
  if (merged.sourceRooms == null) merged.sourceRooms = detail.sourceRooms
  if (!merged.detailFetchedAt) merged.detailFetchedAt = detail.detailFetchedAt
  // Derived from the description by the enrich task (applyDescriptionMarketValue).
  if (merged.marketValue == null) merged.marketValue = detail.marketValue
  if (merged.marketValueEur == null) merged.marketValueEur = detail.marketValueEur
  if (!merged.marketValueText) merged.marketValueText = detail.marketValueText
  if (!merged.currency) merged.currency = detail.currency
  if (!(merged.photoUrls?.length)) merged.photoUrls = detail.photoUrls
  return merged
}

/**
 * The auction snapshot extraction should use, or null when none is archived
 * (or the newest one can't be read). Falls back to the newest snapshot as-is
 * when no older one has detail data.
 */
export async function readArchivedAuctionSnapshot(platform: string, externalId: string): Promise<Auction | null> {
  const captures = await listDistinctCaptures('auction', platform, externalId, SNAPSHOT_SCAN_LIMIT)
  const newest = captures[0]
  if (!newest) return null
  const newestBytes = await downloadBlob(newest.contentHash)
  if (!newestBytes) return null
  const base = parseAuction(newestBytes)
  if (!base) return null
  let merged = base
  for (const capture of captures.slice(1)) {
    const bytes = await downloadBlob(capture.contentHash)
    if (!bytes) continue
    const older = parseAuction(bytes)
    if (!older) continue
    if (hasDetailData(older)) merged = overlayDetailData(merged, older)
    // A newer capture can lack the title an older one carried. Without it
    // (and without detail data) the LLM input is empty, so an older
    // listing-only capture still counts for the title alone.
    else if (!merged.title?.trim() && older.title?.trim()) merged = { ...merged, title: older.title }
  }
  return merged
}
