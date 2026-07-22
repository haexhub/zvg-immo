// Persists the enrich task's final view of every crawled auction (already
// decorated with extraction + Verkehrswert overlays) to Postgres
// (`auction_snapshot` table, WP-5: Postgres is the sole serving store, no
// local JSON file) so the detail page can serve a shareable URL without
// re-crawling. Staleness is bounded by the enrich task interval (cron
// `30 */6 * * *`) — fresh enough for a listing whose key data doesn't change
// once published. No-op without a configured pool, same graceful-degrade as
// current-auctions.ts/extraction-cache.ts.
//
// Detail fields (attachments/description/pdfUrl/…) come from enrichOne, which
// the enrich task runs only for auctions not yet in the extraction cache. On
// subsequent runs those fields are empty on the fresh crawl, so we merge with
// the previous snapshot to keep the enriched values from the first crawl.

import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import { getPool } from './db'
import { cacheKey } from './verkehrswert-cache'

export type AuctionSnapshot = Record<string, Auction>

// WP-1 renamed the Auction fields (DE/ZVG -> neutral English) while the
// snapshot still lived on the JSON volume, so an entry written before the
// rename could carry the old names. Kept for any leftover entry migrated in
// during the WP-5 cutover to Postgres; a full crawl cycle rewrites every
// entry with the new names and this becomes a no-op.
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

// Memoized for the process's lifetime: the enrich task and every API request
// share this same object, so a write (writeAuctionSnapshot below) is
// immediately visible everywhere without re-querying Postgres. Reset to null
// on a failed load so the next call retries instead of caching the failure.
// Same pattern as extraction-cache.ts's readExtractionCache.
let cachePromise: Promise<AuctionSnapshot> | null = null

export async function readAuctionSnapshot(): Promise<AuctionSnapshot> {
  if (!cachePromise) cachePromise = loadAuctionSnapshot()
  try {
    return await cachePromise
  } catch (err) {
    console.warn(`[auction-snapshot] read failed: ${(err as Error).message}`)
    cachePromise = null
    return {}
  }
}

async function loadAuctionSnapshot(): Promise<AuctionSnapshot> {
  const db = getPool()
  if (!db) return {}
  const { rows } = await db.query<{ platform: string; external_id: string; auction: Auction }>(
    'SELECT platform, external_id, auction FROM auction_snapshot',
  )
  const snapshot: AuctionSnapshot = {}
  for (const row of rows) {
    normalizeLegacyAuction(row.auction as unknown as Record<string, unknown>)
    snapshot[cacheKey(row.platform, row.external_id)] = row.auction
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
  if (
    next.marketValueEur == null &&
    next.marketValue == null &&
    (prev.marketValueEur != null || prev.marketValue != null)
  ) {
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
  if (next.startingBid == null && prev.startingBid != null) {
    next.startingBid = prev.startingBid
  }
  if (next.sourceSecurityDeposit == null && prev.sourceSecurityDeposit != null) {
    next.sourceSecurityDeposit = prev.sourceSecurityDeposit
  }
  // currentBid is deliberately NOT preserved here: it's genuinely live auction
  // state (the currently-highest bid during an active online sale), not a
  // static fact like the other source* fields above. A crawl that comes back
  // without it most likely means the bidding period ended — showing a stale
  // figure as if it were still current would be actively misleading.
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
  if (auctions.length === 0) return
  const previous = await readAuctionSnapshot()
  const merged: AuctionSnapshot = {}
  for (const a of auctions) {
    const key = cacheKey(a.platform, a.externalId)
    const prev = previous[key]
    merged[key] = prev ? mergePreservedDetail(a, prev) : a
  }
  // Update the shared in-process cache immediately, mirroring
  // extraction-cache.ts's writeExtractionCache. A platform absent from this
  // crawl (e.g. BOE captcha cooldown) simply isn't touched here or in
  // Postgres (row-level upsert vs. the old whole-file overwrite), so its
  // previous entry survives without any explicit carry-forward.
  Object.assign(previous, merged)
  await upsertAuctionSnapshot(Object.values(merged))
}

// 3 params per row (platform, external_id, auction jsonb) × 500 rows = 1500
// params, well under Postgres' 65535-per-query limit — a smaller chunk than
// extraction_cache's 5000 since a full Auction blob (attachments, photoUrls,
// description) is much larger per row than an AuctionExtraction.
const CHUNK_SIZE = 500

async function upsertAuctionSnapshot(rows: Auction[]): Promise<void> {
  const db = getPool()
  if (!db) return
  if (rows.length === 0) return
  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await upsertChunk(db, rows.slice(i, i + CHUNK_SIZE))
    }
  } catch (err) {
    console.warn(`[auction-snapshot] upsert failed: ${(err as Error).message}`)
  }
}

async function upsertChunk(db: Pool, rows: Auction[]): Promise<void> {
  const values: unknown[] = []
  const tuples: string[] = []
  for (const a of rows) {
    const placeholders = [1, 2, 3].map((n) => `$${values.length + n}`)
    tuples.push(`(${placeholders.join(', ')})`)
    values.push(a.platform, a.externalId, JSON.stringify(a))
  }
  await db.query(
    `
    INSERT INTO auction_snapshot (platform, external_id, auction) VALUES ${tuples.join(', ')}
    ON CONFLICT (platform, external_id) DO UPDATE SET auction = EXCLUDED.auction, updated_at = now()
    `,
    values,
  )
}
