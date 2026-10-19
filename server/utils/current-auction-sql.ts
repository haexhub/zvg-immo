/**
 * SQL conditions (alias `a` = auctions) for "this auction is still on offer".
 * One definition for everything that must ignore expired listings: public
 * search, the Daten-API collection, and LLM candidate selection (reprocess).
 *
 * `auctions` is never pruned, so expiry is applied at read time:
 *  1. a dated auction whose date has passed is over;
 *  2. an undated one (kip, alo, bima, ...) has no date signal, so the only
 *     signal left is a completed crawl of its scope no longer returning it
 *     (auctions.last_seen_at vs crawl_state.last_success_at).
 *
 * Written as NOT EXISTS so every uncertainty resolves to "keep": no crawl_state
 * row for the scope means nothing is hidden, and a broken crawler goes stale
 * rather than emptying its source out.
 *
 * A row no successful crawl has stamped yet has no crawl_region (backfilled
 * that way by migration 0023, or created by geocode/enrich before refresh saw
 * it), so the scope match above can never fire for it. An undated listing that
 * vanished before its first stamp stayed "current" forever — and kept being
 * retried by reprocess every run. For those the platform as a whole decides:
 * once every scope of that platform in that country has completed after the
 * row was last seen, none of them still lists it. COALESCE keeps every unknown
 * (no crawl_state row, no timestamp) on "keep".
 */
export const CURRENT_AUCTION_CONDITIONS: readonly string[] = [
  '(a.auction_date_iso IS NULL OR a.auction_date_iso >= now())',
  `NOT EXISTS (
    SELECT 1 FROM crawl_state cs
     WHERE cs.country = a.country
       AND cs.region = a.crawl_region
       AND cs.platform = a.platform
       AND a.last_seen_at < cs.last_success_at
  )`,
  `NOT COALESCE(
    a.crawl_region IS NULL AND COALESCE(a.last_seen_at, a.first_seen_at) < (
      SELECT MIN(cs.last_success_at) FROM crawl_state cs
       WHERE cs.country = a.country AND cs.platform = a.platform
    ),
    false
  )`,
]
