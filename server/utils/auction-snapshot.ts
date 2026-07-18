// Persists the enrich task's final view of every crawled auction (already
// decorated with extraction + Verkehrswert overlays) to disk so the detail
// page can serve a shareable URL without re-crawling. Staleness is bounded by
// the enrich task interval (cron `30 */6 * * *`) — fresh enough for a
// listing whose key data doesn't change once published.
//
// Detail fields (attachments/description/pdfUrl/…) come from enrichOne, which
// the enrich task runs only for auctions not yet in the extraction cache. On
// subsequent runs those fields are empty on the fresh crawl, so we merge with
// the previous snapshot to keep the enriched values from the first crawl.

import { join } from 'node:path'
import type { Auction } from '~/types/auction'
import { readJsonCache, writeJsonCache } from './json-cache'
import { cacheKey } from './verkehrswert-cache'

const SNAPSHOT_PATH = join(process.cwd(), '.cache_zvg', 'auctions.json')

export type AuctionSnapshot = Record<string, Auction>

// WP-1 renamed the Auction fields (DE/ZVG -> neutral English), but the snapshot
// lives on a persisted volume (docker-compose: geocode-cache:/app/.cache_zvg),
// so entries written before the rename survive the deploy with the old names.
// Consumers (detail endpoint, summary, enrich merge) read the new names and
// would otherwise see `undefined` — and since `detailFetchedAt` (unchanged
// name) is preserved, the enrich task won't re-fetch, so lost detail data
// (description, …) wouldn't self-heal. Map the old names on read; a full crawl
// cycle rewrites entries with the new names and this becomes a no-op. Safe to
// drop once no pre-WP-1 snapshot can still be in play.
const LEGACY_FIELD_MAP: Record<string, keyof Auction> = {
  zvgId: 'externalId',
  aktenzeichen: 'caseNumber',
  amtsgericht: 'authority',
  objekt: 'title',
  adresse: 'address',
  verkehrswertEur: 'marketValueEur',
  verkehrswertText: 'marketValueText',
  terminIso: 'auctionDateIso',
  terminText: 'auctionDateText',
  aufgehoben: 'cancelled',
  letzteAktualisierungIso: 'sourceUpdatedIso',
  beschreibung: 'description',
  fotoCount: 'photoCount',
}

/** Exported for tests. */
export function normalizeLegacyAuction(entry: Record<string, unknown>): void {
  for (const [oldKey, newKey] of Object.entries(LEGACY_FIELD_MAP)) {
    if (entry[newKey] === undefined && entry[oldKey] !== undefined) {
      entry[newKey] = entry[oldKey]
      delete entry[oldKey]
    }
  }
}

export async function readAuctionSnapshot(): Promise<AuctionSnapshot> {
  const snapshot = await readJsonCache<AuctionSnapshot>(SNAPSHOT_PATH, () => ({}), 'auction-snapshot')
  for (const entry of Object.values(snapshot)) {
    normalizeLegacyAuction(entry as unknown as Record<string, unknown>)
  }
  return snapshot
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
  if (next.description == null && prev.description != null) {
    next.description = prev.description
  } else if (
    next.description != null &&
    prev.description != null &&
    prev.detailFetchedAt != null &&
    prev.description.startsWith(next.description)
  ) {
    // enrichOne extends the list text in place (e.g. LV appends Kadastra
    // lines), so the enriched description starts with the fresh list text.
    // A crawl that didn't re-enrich must not truncate it back down.
    next.description = prev.description
  }
  // `caseNumber` is typed as plain string but crawlers emit ''/null when a
  // re-crawl couldn't resolve it — restore the previously known value then.
  if (!next.caseNumber && prev.caseNumber) {
    next.caseNumber = prev.caseNumber
  }
  if (next.pdfUrl == null && prev.pdfUrl != null) {
    next.pdfUrl = prev.pdfUrl
    next.pdfUrlUpstream = prev.pdfUrlUpstream
  }
  if (next.photoCount === 0 && typeof prev.photoCount === 'number' && prev.photoCount > 0) {
    next.photoCount = prev.photoCount
  }
  if (next.thumbnailUrl == null && prev.thumbnailUrl != null) {
    next.thumbnailUrl = prev.thumbnailUrl
  }
  // The value bundle (native marketValue + currency + derived marketValueEur +
  // display text) travels together — restore all four when a re-crawl lost the
  // value entirely (e.g. GB/HU/PL learn it only on the detail page). The extra
  // `next.marketValue == null` guard leaves a fresh native value in place when
  // it merely couldn't be converted to EUR (currency missing from the rates).
  if (next.marketValueEur == null && next.marketValue == null && prev.marketValueEur != null) {
    next.marketValueEur = prev.marketValueEur
    next.marketValueText = prev.marketValueText
    next.marketValue = prev.marketValue ?? null
    next.currency = prev.currency ?? null
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
    // Crawlers keep photoCount in sync with photoUrls (see types/auction.ts);
    // restoring the gallery without the count would leave e.g. photoCount=1
    // from the list crawl next to a 5-image gallery.
    if (!(typeof next.photoCount === 'number') || next.photoCount < prev.photoUrls.length) {
      next.photoCount = prev.photoUrls.length
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
    const key = cacheKey(a.platform, a.externalId)
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
  await writeJsonCache(SNAPSHOT_PATH, map)
}
