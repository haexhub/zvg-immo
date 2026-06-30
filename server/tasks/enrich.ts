// Crawls every registered region and extracts structured fields (property type
// + sizes) from each listing, caching the result to disk. Idempotent: ids
// already in the cache are skipped (first-write-wins), so the first run does
// the work and subsequent runs finish quickly.
//
// Phase 1 runs the deterministic rules pass only, on the listing text that's
// available without detail enrichment (objekt + any beschreibung). The LLM
// fallback and PDF-text input are added in later phases; entries left at
// confidence 'low' here are the candidates those phases will upgrade.
//
// Triggered by the scheduled task config in nuxt.config.ts and once shortly
// after server startup via server/plugins/enrich-bootstrap.ts.

import type { AuctionExtraction } from '~/types/auction'
import { crawlAll } from '../crawlers/registry'
import { extractByRules } from '../utils/extract/rules'
import { readExtractionCache, writeExtractionCache } from '../utils/extraction-cache'
import { cacheKey } from '../utils/verkehrswert-cache'

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions and extract property type + sizes (rules pass) into the disk cache.',
  },
  async run() {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()

    let processed = 0
    let confident = 0
    const at = new Date().toISOString()
    for (const a of result.auctions) {
      const key = cacheKey(a.platform, a.zvgId)
      if (cache[key]) continue
      processed++
      const r = extractByRules({ objekt: a.objekt, beschreibung: a.beschreibung })
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
      cache[key] = entry
      if (r.confident) confident++
    }

    if (processed > 0) await writeExtractionCache(cache)

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} new=${processed} confident=${confident}`,
    )

    return { result: { crawled: result.auctions.length, processed, confident, durationMs } }
  },
})
