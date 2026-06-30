// Crawls every registered region and extracts structured fields (property type
// + sizes) from each listing, caching the result to disk. Idempotent: ids
// already in the cache are skipped, so the first run does the work and
// subsequent runs only process newly-listed auctions.
//
// Detail fetching: the list crawl is cheap (one request per region), but the
// real text for size extraction lives on each auction's detail page. So instead
// of re-enriching every listing on every run (which would hammer the upstream
// portals — BOE in particular has captcha cooldowns), we call the crawler's
// enrichOne() only for auctions not yet in the cache. Each auction's detail is
// therefore fetched at most once, ever.
//
// Phase 2a runs the deterministic rules pass over objekt + beschreibung. PDF
// text and the LLM fallback (for the residual sizes, and non-DE type) come in
// phase 2b; entries left at confidence 'low' here are the candidates that pass
// will upgrade.
//
// Triggered by the scheduled task config in nuxt.config.ts and once shortly
// after server startup via server/plugins/enrich-bootstrap.ts.

import type { AuctionExtraction } from '~/types/auction'
import { crawlAll, platforms } from '../crawlers/registry'
import { extractByRules } from '../utils/extract/rules'
import { readExtractionCache, writeExtractionCache } from '../utils/extraction-cache'
import { cacheKey } from '../utils/verkehrswert-cache'

// Detail fetches across all platforms run at this concurrency. Kept modest so
// a cold run doesn't trip rate limits (BOE) while still finishing reasonably.
const ENRICH_CONCURRENCY = 8
// Checkpoint the cache periodically so a crash during a long cold run doesn't
// lose all progress.
const FLUSH_EVERY = 200

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions and extract property type + sizes (rules pass) for new listings into the disk cache.',
  },
  async run() {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))

    const todo = result.auctions.filter((a) => !cache[cacheKey(a.platform, a.zvgId)])
    console.log(`[enrich] crawled ${result.auctions.length}, ${todo.length} new to process`)

    let cached = 0
    let confident = 0
    let enrichedCount = 0
    const at = new Date().toISOString()

    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        const a = todo[cursor++]
        if (!a) continue
        const crawler = byPlatform.get(a.platform)

        // Pull the detail page (beschreibung + attachments) so the rules have
        // real text to parse. Best-effort: a failed fetch just means the rules
        // run on objekt alone.
        let enriched = false
        if (crawler?.enrichOne) {
          try {
            await crawler.enrichOne(a)
            enriched = a.beschreibung != null || a.attachments.length > 0
          } catch {
            // Transient (network / BOE captcha). Leave the auction uncached so
            // a later run retries the detail fetch instead of locking in a
            // text-poor result forever.
          }
        }
        if (enriched) enrichedCount++

        const r = extractByRules({ objekt: a.objekt, beschreibung: a.beschreibung })

        // Cache when we got real detail, when the result is already confident,
        // or when this crawler can't enrich a single item (nothing to retry).
        const cacheable = enriched || r.confident || !crawler?.enrichOne
        if (!cacheable) continue

        const entry: AuctionExtraction = {
          propertyType: r.propertyType,
          landAreaSqm: r.landAreaSqm,
          livingAreaSqm: r.livingAreaSqm,
          rooms: r.rooms,
          units: r.units,
          source: 'rules',
          confidence: r.confident ? 'high' : 'low',
          at,
        }
        cache[cacheKey(a.platform, a.zvgId)] = entry
        cached++
        if (r.confident) confident++
        if (cached % FLUSH_EVERY === 0) await writeExtractionCache(cache)
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))

    if (cached > 0) await writeExtractionCache(cache)

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} new=${todo.length} cached=${cached} enriched=${enrichedCount} confident=${confident}`,
    )

    return {
      result: {
        crawled: result.auctions.length,
        new: todo.length,
        cached,
        enriched: enrichedCount,
        confident,
        durationMs,
      },
    }
  },
})
