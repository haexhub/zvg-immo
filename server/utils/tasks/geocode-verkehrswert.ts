import type { Auction } from '~/types/auction'
import { enrichInBatches as enrichAtDetails } from '~/server/crawlers/at/detail'
import { enrichInBatches as enrichBidditDetails, formatVerkehrswertText } from '~/server/crawlers/biddit/detail'
import { readAuctionRecordsByKeys, type AuctionKey } from '~/server/utils/auction-record'
import { CURRENT_AUCTION_CONDITIONS } from '~/server/utils/current-auction-sql'
import { getPool } from '~/server/utils/db'
import { throwIfTaskAborted } from '~/server/utils/exclusive-task'
import {
  cacheKey,
  readVerkehrswertCache,
  writeVerkehrswertCache,
  type VerkehrswertCache,
} from '~/server/utils/verkehrswert-cache'

export interface VerkehrswertStats {
  added: number
  errors: number
}

// Records are read for this many missing auctions at a time, so only one
// chunk of records is ever resident (a cold cache misses every AT/BE lot).
const RECORD_CHUNK_SIZE = 500

/**
 * AT-Edikte and Biddit both hide their Schätzwert / estimatedPrice on the
 * listing path the API uses. Fetch the detail page once for every current
 * stored auction the cache doesn't know yet and persist the value so the API
 * can overlay it read-only. Works from the store (crawled and persisted by
 * enrich), never from a crawl of its own.
 *
 * The cache is loaded once and shared — two concurrent writers would each
 * rebuild the file from their own local read, silently dropping the sibling's
 * entries — and written even when a run is aborted, so the detail fetches
 * that did finish are kept.
 */
export async function enrichStoredVerkehrswert(
  countries: readonly string[],
  signal: AbortSignal,
): Promise<{ at: VerkehrswertStats; be: VerkehrswertStats }> {
  const cache: VerkehrswertCache = { ...(await readVerkehrswertCache()) }
  const at: VerkehrswertStats = { added: 0, errors: 0 }
  const be: VerkehrswertStats = { added: 0, errors: 0 }
  const settled = await Promise.allSettled([
    enrichAtVerkehrswert(countries, cache, at, signal),
    enrichBidditVerkehrswert(countries, cache, be, signal),
  ])
  if (at.added + be.added > 0) await writeVerkehrswertCache(cache)
  for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason
  return { at, be }
}

/** Identity of every current stored auction of one platform. */
export async function findCurrentAuctionKeys(platform: string, countries: readonly string[]): Promise<AuctionKey[]> {
  if (countries.length === 0) return []
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<{ platform: string; external_id: string }>(
    `SELECT a.platform, a.external_id
       FROM auctions a
      WHERE a.platform = $1
        AND a.country = ANY($2)
        AND ${CURRENT_AUCTION_CONDITIONS.join(' AND ')}
      ORDER BY a.external_id`,
    [platform, countries],
  )
  return rows.map((row) => ({ platform: row.platform, externalId: row.external_id }))
}

async function enrichFromStore(
  keys: readonly AuctionKey[],
  signal: AbortSignal,
  enrich: (auctions: Auction[]) => Promise<{ errors: number }>,
): Promise<number> {
  let errors = 0
  for (let start = 0; start < keys.length; start += RECORD_CHUNK_SIZE) {
    throwIfTaskAborted(signal)
    const records = await readAuctionRecordsByKeys(keys.slice(start, start + RECORD_CHUNK_SIZE), { includePhotos: false })
    const auctions = [...records.values()].map((record) => record.auction)
    if (auctions.length > 0) errors += (await enrich(auctions)).errors
  }
  return errors
}

async function enrichAtVerkehrswert(
  countries: readonly string[],
  cache: VerkehrswertCache,
  stats: VerkehrswertStats,
  signal: AbortSignal,
): Promise<void> {
  const keys = await findCurrentAuctionKeys('at-edikte', countries)
  if (keys.length === 0) return

  const toFetch = keys.filter((key) => !(cacheKey(key.platform, key.externalId) in cache))
  if (toFetch.length === 0) {
    console.log(`[geocode] verkehrswert(at): ${keys.length} entries, all cached`)
    return
  }
  console.log(`[geocode] verkehrswert(at): fetching ${toFetch.length}/${keys.length} missing details`)

  // The detail fetch needs the stored detailUrlUpstream — hence the records.
  stats.errors += await enrichFromStore(toFetch, signal, (auctions) =>
    enrichAtDetails(auctions, (auction, info) => {
      cache[cacheKey('at-edikte', auction.externalId)] = {
        marketValueEur: info.schaetzwertEur,
        marketValueText: info.schaetzwertText,
      }
      stats.added++
    }))
}

// Biddit's estimatedPrice is on the detail (BFF) JSON but not on the search
// listing the /api/auctions crawl uses. Mirror the AT flow: fetch once per new
// auction, store null when the field is a placeholder so we don't re-fetch it
// every run.
async function enrichBidditVerkehrswert(
  countries: readonly string[],
  cache: VerkehrswertCache,
  stats: VerkehrswertStats,
  signal: AbortSignal,
): Promise<void> {
  const keys = await findCurrentAuctionKeys('biddit', countries)
  if (keys.length === 0) return

  // Also refetch cached nulls once: before the startingPrice fallback existed,
  // every lot cached null (estimatedPrice is a placeholder platform-wide), and
  // first-write-wins would keep those nulls forever. The `retried` marker keeps
  // this a one-time backfill — lots that genuinely have no price don't get
  // re-fetched on every run.
  const toFetch = keys.filter((key) => {
    const hit = cache[cacheKey(key.platform, key.externalId)]
    return hit == null || (hit.marketValueEur == null && !hit.retried)
  })
  if (toFetch.length === 0) {
    console.log(`[geocode] verkehrswert(be): ${keys.length} entries, all cached`)
    return
  }
  console.log(`[geocode] verkehrswert(be): fetching ${toFetch.length}/${keys.length} missing details`)

  stats.errors += await enrichFromStore(toFetch, signal, (auctions) =>
    enrichBidditDetails(auctions, (auction, info) => {
      cache[cacheKey('biddit', auction.externalId)] = {
        marketValueEur: info.estimatedPrice,
        marketValueText: formatVerkehrswertText(info),
        ...(info.estimatedPrice == null ? { retried: true } : {}),
      }
      stats.added++
    }))
}
