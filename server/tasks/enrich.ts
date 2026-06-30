// Crawls every registered region and extracts structured fields (property type
// + sizes) from each listing, caching the result to disk. Idempotent: ids
// already in the cache are skipped, so the first run does the work and
// subsequent runs only process newly-listed auctions.
//
// Detail fetching: the list crawl is cheap (one request per region), but the
// real text for extraction lives on each auction's detail page. So instead of
// re-enriching every listing on every run (which would hammer the upstream
// portals — BOE in particular has captcha cooldowns), we call the crawler's
// enrichOne() only for auctions not yet in the cache. Each auction's detail is
// therefore fetched at most once, ever.
//
// Extraction is two-tier:
//   1. Deterministic rules over objekt + beschreibung (free, precise). If they
//      yield a confident result we stop there.
//   2. Otherwise, when the LLM is configured (runtimeConfig.extractLlm.baseUrl),
//      fall back to Claude-via-haex-claude-proxy with the best Gutachten/Exposé
//      PDF text mixed in — for the sizes rules can't find and for non-German
//      property types the German classifier misses. LLM calls are capped per
//      run so a cold start doesn't spawn thousands of proxy subprocesses at once.
//
// Triggered by the scheduled task config in nuxt.config.ts and once shortly
// after server startup via server/plugins/enrich-bootstrap.ts.

import type { AuctionExtraction } from '~/types/auction'
import { crawlAll, platforms } from '../crawlers/registry'
import { extractByRules } from '../utils/extract/rules'
import { extractByLlm, type LlmConfig } from '../utils/extract/llm'
import { pdfToText, pickBestPdf } from '../utils/extract/pdf-text'
import { readExtractionCache, writeExtractionCache } from '../utils/extraction-cache'
import { cacheKey } from '../utils/verkehrswert-cache'

const ENRICH_CONCURRENCY = 8
const FLUSH_EVERY = 200
// Cap LLM calls per run so a cold start spreads its load over several runs
// instead of spawning thousands of proxy subprocesses at once.
const MAX_LLM_PER_RUN = 250

function readLlmConfig(): LlmConfig | null {
  const c = useRuntimeConfig().extractLlm as { baseUrl?: string; model?: string } | undefined
  if (!c?.baseUrl) return null
  return { baseUrl: c.baseUrl, model: c.model || 'claude-haiku-4-5' }
}

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions and extract property type + sizes (rules + LLM fallback) for new listings into the disk cache.',
  },
  async run() {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))
    const llmConfig = readLlmConfig()

    const todo = result.auctions.filter((a) => !cache[cacheKey(a.platform, a.zvgId)])
    console.log(
      `[enrich] crawled ${result.auctions.length}, ${todo.length} new · llm=${llmConfig ? llmConfig.model : 'off'}`,
    )

    let cached = 0
    let confident = 0
    let enrichedCount = 0
    let llmCalls = 0
    const at = new Date().toISOString()

    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        const a = todo[cursor++]
        if (!a) continue
        const crawler = byPlatform.get(a.platform)

        // Detail fetch (beschreibung + attachments) so extraction has real text.
        let enriched = false
        if (crawler?.enrichOne) {
          try {
            await crawler.enrichOne(a)
            enriched = a.beschreibung != null || a.attachments.length > 0
          } catch {
            // Transient (network / BOE captcha) — handled by detailOk below.
          }
        }
        if (enriched) enrichedCount++
        const detailOk = enriched || !crawler?.enrichOne

        const rules = extractByRules({ objekt: a.objekt, beschreibung: a.beschreibung })
        let fields = {
          propertyType: rules.propertyType,
          landAreaSqm: rules.landAreaSqm,
          livingAreaSqm: rules.livingAreaSqm,
          rooms: rules.rooms,
          units: rules.units,
        }
        let source: 'rules' | 'llm' = 'rules'
        let cacheable: boolean

        if (rules.confident) {
          cacheable = true
        } else if (llmConfig && llmCalls < MAX_LLM_PER_RUN) {
          llmCalls++
          const pdf = pickBestPdf(a.attachments)
          const pdfText = pdf ? await pdfToText(pdf.proxyUrl) : null
          const llm = await extractByLlm(
            { objekt: a.objekt, beschreibung: a.beschreibung, pdfText },
            llmConfig,
          )
          if (llm === null) {
            cacheable = false // LLM call failed → leave for a later run
          } else {
            source = 'llm'
            // Prefer the precise rules values; fill the gaps from the LLM.
            fields = {
              propertyType: rules.propertyType ?? llm.propertyType,
              landAreaSqm: rules.landAreaSqm ?? llm.landAreaSqm,
              livingAreaSqm: rules.livingAreaSqm ?? llm.livingAreaSqm,
              rooms: rules.rooms ?? llm.rooms,
              units: rules.units ?? llm.units,
            }
            cacheable = true
          }
        } else {
          // LLM disabled (or per-run cap hit): cache the rules result if we had
          // real text to work with, else leave it for a later run to retry.
          cacheable = detailOk
        }

        if (!cacheable) continue

        const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
        const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
        const entry: AuctionExtraction = {
          ...fields,
          source,
          confidence: hasType && hasArea ? 'high' : 'low',
          at,
        }
        cache[cacheKey(a.platform, a.zvgId)] = entry
        cached++
        if (entry.confidence === 'high') confident++
        if (cached % FLUSH_EVERY === 0) await writeExtractionCache(cache)
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))

    if (cached > 0) await writeExtractionCache(cache)

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} new=${todo.length} cached=${cached} enriched=${enrichedCount} llmCalls=${llmCalls} confident=${confident}`,
    )

    return {
      result: {
        crawled: result.auctions.length,
        new: todo.length,
        cached,
        enriched: enrichedCount,
        llmCalls,
        confident,
        durationMs,
      },
    }
  },
})
