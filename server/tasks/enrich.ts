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

import { join } from 'node:path'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { crawlAll, platforms } from '../crawlers/registry'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { extractByRules } from '../utils/extract/rules'
import { extractByLlm, type LlmConfig } from '../utils/extract/llm'
import { downloadNativeImages } from '../utils/extract/native-images'
import { extractPdfPhotos } from '../utils/extract/pdf-images'
import { pdfToText, pickBestPdf } from '../utils/extract/pdf-text'
import {
  applyExtractionToAuctions,
  readExtractionCache,
  writeExtractionCache,
} from '../utils/extraction-cache'
import { isSafePathSegment } from '../utils/path-segment'
import { cacheKey, readVerkehrswertCache } from '../utils/verkehrswert-cache'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const ENRICH_CONCURRENCY = 8
const FLUSH_EVERY = 200
// Cap LLM calls per run so a cold start spreads its load over several runs
// instead of spawning thousands of proxy subprocesses at once.
// Deliberately low: field extraction is best-effort; the detail page's on-demand
// summary covers what background enrichment misses.
const MAX_LLM_PER_RUN = 30

function readLlmConfig(): LlmConfig | null {
  const c = useRuntimeConfig().extractLlm as { baseUrl?: string; model?: string } | undefined
  if (!c?.baseUrl) return null
  return { baseUrl: c.baseUrl, model: c.model || 'claude-haiku-4-5' }
}

// Guards against overlapping runs: a cold-start bootstrap run (many detail
// fetches + PDF work) can still be active when the cron tick fires. Two
// concurrent runs would double-fetch details and race on the snapshot write.
let running = false

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions and extract property type + sizes (rules + LLM fallback) for new listings into the disk cache.',
  },
  async run() {
    if (running) {
      console.warn('[enrich] previous run still in progress — skipping')
      return { result: undefined }
    }
    running = true
    try {
      return await runEnrich()
    } finally {
      running = false
    }
  },
})

async function runEnrich() {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()
    const previousSnapshot = await readAuctionSnapshot()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))
    const llmConfig = readLlmConfig()

    // Two independent reasons to enrich: no extraction yet, OR the previous
    // snapshot never recorded a detail fetch (`detailFetchedAt` absent) —
    // meaning enrichOne either never ran or ran before the marker existed and
    // is due for a one-shot backfill. Once the marker is set, the listing
    // drops out of the todo list even if it legitimately has no attachments /
    // beschreibung (which would otherwise cause endless retries).
    const needsEnrich = (a: Auction): boolean => {
      const crawler = byPlatform.get(a.platform)
      if (!crawler?.enrichOne) return false
      const prev = previousSnapshot[cacheKey(a.platform, a.zvgId)]
      return !prev?.detailFetchedAt
    }
    // A prior run may have hit the per-run LLM cap before reaching this
    // listing's turn and cached a rules-only 'low' result to avoid re-running
    // rules forever (see the cacheable fallback below). Once the LLM has
    // actually seen the text and still came up empty, don't retry — the text
    // hasn't changed, so nothing would improve; only retry the ones the LLM
    // never got to.
    const needsLlmRetry = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.zvgId)]
      return hit?.source === 'rules' && hit.confidence === 'low'
    }
    const todo = result.auctions.filter(
      (a) => !cache[cacheKey(a.platform, a.zvgId)] || needsEnrich(a) || needsLlmRetry(a),
    )
    console.log(
      `[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)enrich · llm=${llmConfig ? llmConfig.model : 'off'}`,
    )

    let cached = 0
    let confident = 0
    let enrichedCount = 0
    let llmCalls = 0
    let photoExtractions = 0
    let photosTotal = 0
    const at = new Date().toISOString()

    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        const a = todo[cursor++]
        if (!a) continue
        const crawler = byPlatform.get(a.platform)
        const key = cacheKey(a.platform, a.zvgId)
        const extractionMissing = !cache[key] || needsLlmRetry(a)

        // Detail fetch (beschreibung + attachments) so extraction has real text
        // and the snapshot writer has enrichOne-populated fields to persist.
        // Stamp detailFetchedAt when enrichOne returned without throwing — even
        // if the listing legitimately has no attachments/beschreibung — so we
        // don't re-fetch the same empty response on every future run.
        let enriched = false
        if (crawler?.enrichOne) {
          try {
            await crawler.enrichOne(a)
            enriched = a.beschreibung != null || a.attachments.length > 0
            a.detailFetchedAt = at
          } catch {
            // Transient (network / BOE captcha): leave detailFetchedAt unset so
            // this listing is retried on the next run.
          }
        }
        if (enriched) enrichedCount++
        const detailOk = enriched || !crawler?.enrichOne

        // Skip the rules/LLM/photo extraction pipeline when we already have a
        // cached result — this loop iteration may only be here to backfill
        // snapshot detail data (see needsEnrich above). Overwriting the cache
        // would clobber a prior LLM extraction with a downgraded rules-only one.
        if (!extractionMissing) continue

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
        const bestPdf = pickBestPdf(a.attachments)

        if (rules.confident) {
          cacheable = true
        } else if (llmConfig && llmCalls < MAX_LLM_PER_RUN) {
          llmCalls++
          const pdfText = bestPdf ? await pdfToText(bestPdf.proxyUrl) : null
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
        } else if (llmConfig) {
          // Per-run LLM cap hit: don't cache the rules-only result — that would
          // mark this listing "done" and needsLlmRetry above would never see it
          // again. Leave it uncached so it's retried (and gets its LLM shot)
          // once a slot frees up on a later run.
          cacheable = false
        } else {
          // LLM disabled entirely: cache the rules result if we had real text
          // to work with, else leave it for a later run to retry.
          cacheable = detailOk
        }

        if (!cacheable) continue

        // Two-way photo pipeline (platform/zvgId guard applies to both — the
        // API endpoint enforces the same shape, so files under an unsafe path
        // would be unreachable anyway):
        //   a) Native image URLs from the crawler's foto attachments — AT
        //      (edikte.justiz.gv.at JPGs) and Biddit (biddit.be JPEGs) publish
        //      photos directly. We mirror them into the local image cache so
        //      the browser fetches from us, not the upstream on every card.
        //   b) When (a) yields nothing (no native URLs, or all downloads
        //      failed), mine the best PDF for embedded rasters — but only if
        //      the listing didn't already declare foto attachments, since
        //      Gutachten photos are a different set from the listing's own
        //      Foto.pdf/JPG and we don't want to overwrite them.
        // Wrapped in try/catch so a disk-full or subprocess failure on one
        // listing can't reject the whole Promise.all — mirrors the enrichOne
        // pattern above.
        let photos: string[] = []
        if (isSafePathSegment(a.platform) && isSafePathSegment(a.zvgId)) {
          const destDir = join(IMAGES_DIR, a.platform, a.zvgId)
          const nativeFotoUrls = a.attachments
            .filter(
              (att) =>
                att.kind === 'foto' &&
                /^https?:\/\/.*\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(att.proxyUrl),
            )
            .map((att) => att.proxyUrl)
          try {
            if (nativeFotoUrls.length > 0) {
              photos = await downloadNativeImages(nativeFotoUrls, { destDir })
            }
            if (photos.length === 0 && bestPdf && a.fotoCount === 0) {
              photoExtractions++
              photos = await extractPdfPhotos(bestPdf.proxyUrl, { destDir })
            }
            photosTotal += photos.length
          } catch (err) {
            console.warn(
              `[enrich] photo extraction failed for ${a.platform}:${a.zvgId}: ${(err as Error).message}`,
            )
          }
        }

        const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
        const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
        const entry: AuctionExtraction = {
          ...fields,
          source,
          confidence: hasType && hasArea ? 'high' : 'low',
          photos: photos.length > 0 ? photos : undefined,
          at,
        }
        cache[key] = entry
        cached++
        if (entry.confidence === 'high') confident++
        if (cached % FLUSH_EVERY === 0) await writeExtractionCache(cache)
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))

    if (cached > 0) await writeExtractionCache(cache)

    // Snapshot the fully decorated crawl (extraction + photo URLs + cached
    // Verkehrswerte) so /api/auction/[platform]/[id] can serve detail pages
    // without re-running the crawlers. The same overlays /api/auctions applies
    // are applied here so the snapshot matches what the list view sees.
    const vwCache = await readVerkehrswertCache()
    for (const a of result.auctions) {
      if (a.verkehrswertEur != null) continue
      const hit = vwCache[cacheKey(a.platform, a.zvgId)]
      if (!hit) continue
      a.verkehrswertEur = hit.verkehrswertEur
      a.verkehrswertText = hit.verkehrswertText
    }
    applyExtractionToAuctions(result.auctions, cache)
    await writeAuctionSnapshot(result.auctions)

    const durationMs = Date.now() - startedAt
    console.log(
      `[enrich] done in ${(durationMs / 1000).toFixed(0)}s · crawled=${result.auctions.length} new=${todo.length} cached=${cached} enriched=${enrichedCount} llmCalls=${llmCalls} photos=${photosTotal}/${photoExtractions} confident=${confident}`,
    )

    return {
      result: {
        crawled: result.auctions.length,
        new: todo.length,
        cached,
        enriched: enrichedCount,
        llmCalls,
        photoExtractions,
        photosTotal,
        confident,
        durationMs,
      },
    }
}
