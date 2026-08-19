// When each crawl scope (country, region code, platform) last completed
// successfully, plus the per-auction "still offered" bookkeeping that hangs
// off it. Replaces list-cache.ts: that module stored an entire CrawlResult as
// one JSONB blob per region, but since WP-0 moved serving to the structured
// auctions / auction_details / auction_fetch_state tables, only its
// `fetched_at` was still read.
//
// Why this exists at all: most portals publish no "sold"/"withdrawn" flag, and
// eight of the registered platforms (agi, bima, dga-ag, gb, kip, lt, pt, us)
// never carry an auction date either, so there is nothing to expire against.
// The one signal available is that a listing stopped being returned by a crawl
// that did run to completion — which is exactly what these two tables record.

import type { CrawlResult } from '~/types/auction'
import { getPool } from './db'

const CHUNK_SIZE = 500

/**
 * Records one completed crawl scope: stamps `last_seen_at`/`crawl_region` on
 * every auction the crawl returned, then marks the scope itself successful at
 * the same instant. Both halves use one timestamp so the staleness comparison
 * in buildAuctionSearchFilter is an exact `>=` rather than a fuzzy window.
 *
 * Order matters. Auctions are stamped BEFORE crawl_state, so a crash in
 * between leaves the previous (older) success timestamp in place and nothing
 * is hidden — the reverse order would briefly mark every auction in the scope
 * as disappeared. For the same reason this only ever writes on success; a
 * failed crawl leaves both sides untouched.
 */
export async function recordCrawlScope(
  country: string,
  region: string,
  result: CrawlResult,
  at: string,
): Promise<void> {
  const db = getPool()
  if (!db) return
  // A platform that threw is absent here even when others covering the same
  // region succeeded (crawlSingle merges survivors), so its auctions keep
  // their old last_seen_at and its scope row keeps its old timestamp.
  if (result.platformsSucceeded.length === 0) return
  try {
    const keys = result.auctions.map((a) => [a.platform, a.externalId] as const)
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE)
      const values: unknown[] = [at, region]
      const tuples = chunk.map(([platform, externalId]) => {
        values.push(platform, externalId)
        return `($${values.length - 1}, $${values.length})`
      })
      await db.query(
        `UPDATE auctions SET last_seen_at = $1, crawl_region = $2
          WHERE (platform, external_id) IN (${tuples.join(', ')})`,
        values,
      )
    }

    const countByPlatform = new Map<string, number>()
    for (const a of result.auctions) {
      countByPlatform.set(a.platform, (countByPlatform.get(a.platform) ?? 0) + 1)
    }
    const values: unknown[] = [country, region, at]
    const rows = result.platformsSucceeded.map((platform) => {
      values.push(platform, countByPlatform.get(platform) ?? 0)
      return `($1, $2, $${values.length - 1}, $3, $${values.length})`
    })
    await db.query(
      `INSERT INTO crawl_state (country, region, platform, last_success_at, auction_count)
       VALUES ${rows.join(', ')}
       ON CONFLICT (country, region, platform)
       DO UPDATE SET last_success_at = EXCLUDED.last_success_at, auction_count = EXCLUDED.auction_count`,
      values,
    )
  } catch (err) {
    console.warn(`[crawl-state] record ${country}/${region}: ${(err as Error).message}`)
  }
}

/**
 * Age (ms) of a region's stalest platform, or null when any platform covering
 * it has never been crawled. The hourly background refresh uses this to skip
 * regions crawled recently enough for their portal's cadence (see
 * server/crawlers/crawl-cadence.ts).
 *
 * MIN, not MAX: a region is due again as soon as its least recently crawled
 * platform is due, otherwise a newly added platform would never get its first
 * crawl just because a sibling platform keeps the region looking fresh.
 */
export async function regionCrawlAgeMs(
  country: string,
  region: string,
  platformIds: readonly string[],
): Promise<number | null> {
  const db = getPool()
  if (!db || platformIds.length === 0) return null
  try {
    const { rows } = await db.query<{ oldest: string | null; covered: string }>(
      `SELECT MIN(last_success_at) AS oldest, COUNT(*) AS covered
         FROM crawl_state
        WHERE country = $1 AND region = $2 AND platform = ANY($3::text[])`,
      [country, region, [...platformIds]],
    )
    const row = rows[0]
    if (!row?.oldest || Number(row.covered) < platformIds.length) return null
    return Date.now() - new Date(row.oldest).getTime()
  } catch (err) {
    console.warn(`[crawl-state] region age ${country}/${region}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Age (ms) of the most recently crawled scope overall, or null when nothing
 * has been crawled yet. The boot-time refresh/enrich plugins use this to skip
 * a full re-crawl when a restart lands on already-warm data.
 */
export async function crawlStateAgeMs(): Promise<number | null> {
  const db = getPool()
  if (!db) return null
  try {
    const { rows } = await db.query<{ newest: string | null }>(
      'SELECT MAX(last_success_at) AS newest FROM crawl_state',
    )
    const newest = rows[0]?.newest
    return newest ? Date.now() - new Date(newest).getTime() : null
  } catch (err) {
    console.warn(`[crawl-state] age check: ${(err as Error).message}`)
    return null
  }
}
