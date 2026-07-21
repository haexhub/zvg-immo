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
//   1. Deterministic rules over title + description (free, precise). If they
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
import { deriveMarketValueEur, getRates } from '../utils/exchange-rate'
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
import { interleaveByPlatform } from '../utils/interleave-by-platform'
import { isSafePathSegment } from '../utils/path-segment'
import { archiveAuction } from '../utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '../utils/verkehrswert-cache'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

const ENRICH_CONCURRENCY = 8
const FLUSH_EVERY = 200
// Cap LLM calls per run so a cold start spreads its load over several runs
// instead of spawning thousands of proxy subprocesses at once. ENRICH_CONCURRENCY
// already bounds how many run *at once*; this just bounds the total per run.
// Overridable via NUXT_EXTRACT_LLM_MAX_PER_RUN (see nuxt.config.ts) — meant to
// be raised temporarily while only one country is being crawled, to clear its
// backlog in a handful of runs instead of trickling in over weeks.
const DEFAULT_MAX_LLM_PER_RUN = 300

function readLlmConfig(): LlmConfig | null {
  const c = useRuntimeConfig().extractLlm as
    | { baseUrl?: string; model?: string; maxPerRun?: string }
    | undefined
  if (!c?.baseUrl) return null
  return { baseUrl: c.baseUrl, model: c.model || 'claude-haiku-4-5' }
}

function readMaxLlmPerRun(): number {
  const raw = Number((useRuntimeConfig().extractLlm as { maxPerRun?: string })?.maxPerRun)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LLM_PER_RUN
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
    const rates = await getRates()

    // Two independent reasons to enrich: no extraction yet, OR the previous
    // snapshot never recorded a detail fetch (`detailFetchedAt` absent) —
    // meaning enrichOne either never ran or ran before the marker existed and
    // is due for a one-shot backfill. Once the marker is set, the listing
    // drops out of the todo list even if it legitimately has no attachments /
    // description (which would otherwise cause endless retries).
    const needsEnrich = (a: Auction): boolean => {
      const crawler = byPlatform.get(a.platform)
      if (!crawler?.enrichOne) return false
      const prev = previousSnapshot[cacheKey(a.platform, a.externalId)]
      return !prev?.detailFetchedAt
    }
    // A prior run may have hit the per-run LLM cap before reaching this
    // listing's turn and cached a rules-only 'low' result to avoid re-running
    // rules forever (see the cacheable fallback below). Once the LLM has
    // actually seen the text and still came up empty, don't retry — the text
    // hasn't changed, so nothing would improve; only retry the ones the LLM
    // never got to.
    const needsLlmRetry = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      return hit?.source === 'rules' && hit.confidence === 'low'
    }
    const eligible = result.auctions.filter(
      (a) => !cache[cacheKey(a.platform, a.externalId)] || needsEnrich(a) || needsLlmRetry(a),
    )
    const todo = interleaveByPlatform(eligible)
    const maxLlmPerRun = readMaxLlmPerRun()
    console.log(
      `[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)enrich · llm=${llmConfig ? llmConfig.model : 'off'} maxLlmPerRun=${maxLlmPerRun}`,
    )

    let cached = 0
    let confident = 0
    let enrichedCount = 0
    let llmCalls = 0
    let photoExtractions = 0
    let photosTotal = 0
    const at = new Date().toISOString()

    // maxLlmPerRun is shared across all platforms, but which item reaches
    // the check first depends on how fast its enrichOne/pdfToText preamble
    // resolves — not on interleaveByPlatform's intended round-robin order. A
    // platform whose detail fetch is consistently slower than others (e.g. it
    // needs a live HTML page plus a PDF download+pdftotext on every retry)
    // loses that race run after run and never gets its fair share of the
    // budget. A per-platform cap makes the fairness hold regardless of
    // completion order.
    const llmPlatformCount = new Set(todo.map((a) => a.platform)).size || 1
    const llmCapPerPlatform = Math.max(1, Math.ceil(maxLlmPerRun / llmPlatformCount))
    const llmCallsByPlatform = new Map<string, number>()

    let cursor = 0
    async function worker() {
      while (cursor < todo.length) {
        const a = todo[cursor++]
        if (!a) continue
        const crawler = byPlatform.get(a.platform)
        const key = cacheKey(a.platform, a.externalId)
        const extractionMissing = !cache[key] || needsLlmRetry(a)

        // Detail fetch (description + attachments) so extraction has real text
        // and the snapshot writer has enrichOne-populated fields to persist.
        // Stamp detailFetchedAt when enrichOne returned without throwing — even
        // if the listing legitimately has no attachments/description — so we
        // don't re-fetch the same empty response on every future run.
        let enriched = false
        let detailOk = !crawler?.enrichOne
        if (crawler?.enrichOne) {
          try {
            await crawler.enrichOne(a)
            deriveMarketValueEur(a, rates)
            detailOk = true
            // Any enrichOne-populated field counts — some platforms yield only
            // structured values or a photo gallery, no description/attachments.
            enriched =
              a.description != null ||
              a.attachments.length > 0 ||
              a.sourceLivingAreaSqm != null ||
              a.sourceLandAreaSqm != null ||
              a.sourceRooms != null ||
              (a.photoUrls?.length ?? 0) > 0 ||
              a.lat != null
            a.detailFetchedAt = at
            // Re-archive now that detail data (description/attachments/
            // source*) is on the auction — a new content hash whenever
            // enrichment actually added something (see raw-archive.ts).
            await archiveAuction(a, at)
          } catch {
            // Transient (network / BOE captcha): leave detailFetchedAt unset so
            // this listing is retried on the next run.
          }
        }
        if (enriched) enrichedCount++

        // Skip the rules/LLM/photo extraction pipeline when we already have a
        // cached result — this loop iteration may only be here to backfill
        // snapshot detail data (see needsEnrich above). Overwriting the cache
        // would clobber a prior LLM extraction with a downgraded rules-only one.
        if (!extractionMissing) continue

        const rules = extractByRules({ title: a.title, description: a.description })
        // Structured values straight from the source platform beat anything
        // parsed out of free text — they are the platform's own data, not a
        // regex guess.
        let fields = {
          propertyType: rules.propertyType,
          landAreaSqm: a.sourceLandAreaSqm ?? rules.landAreaSqm,
          livingAreaSqm: a.sourceLivingAreaSqm ?? rules.livingAreaSqm,
          rooms: a.sourceRooms ?? rules.rooms,
          units: rules.units,
        }
        const mergedConfident =
          rules.confident ||
          (fields.propertyType != null &&
            fields.propertyType !== 'sonstiges' &&
            (fields.landAreaSqm != null || fields.livingAreaSqm != null))
        let source: 'rules' | 'llm' = 'rules'
        let cacheable: boolean
        const bestPdf = pickBestPdf(a.attachments)
        // Fetching (and archiving) the best appraisal PDF happens here
        // regardless of whether rules already found a confident result — the
        // archive's purpose is preserving the source document for
        // re-processing, independent of today's extraction outcome. The
        // on-disk text cache in pdfToText means this is a no-op fetch/archive
        // on any run after the first for a given PDF.
        const pdfText = bestPdf
          ? await pdfToText(bestPdf.proxyUrl, {
              identity: {
                platform: a.platform,
                country: a.country,
                externalId: a.externalId,
                caseNumber: a.caseNumber,
                authority: a.authority,
              },
              capturedAt: at,
            })
          : null

        const platformLlmCalls = llmCallsByPlatform.get(a.platform) ?? 0
        if (mergedConfident) {
          cacheable = true
        } else if (
          llmConfig &&
          llmCalls < maxLlmPerRun &&
          platformLlmCalls < llmCapPerPlatform
        ) {
          llmCalls++
          llmCallsByPlatform.set(a.platform, platformLlmCalls + 1)
          const llm = await extractByLlm(
            { title: a.title, description: a.description, pdfText },
            llmConfig,
          )
          if (llm === null) {
            cacheable = false // LLM call failed → leave for a later run
          } else {
            source = 'llm'
            // Prefer the precise structured/rules values; fill the gaps from the LLM.
            // "sonstiges" counts as absent for propertyType (see mergedConfident
            // above) — let a more specific LLM classification replace it.
            fields = {
              propertyType:
                fields.propertyType != null && fields.propertyType !== 'sonstiges'
                  ? fields.propertyType
                  : llm.propertyType,
              landAreaSqm: fields.landAreaSqm ?? llm.landAreaSqm,
              livingAreaSqm: fields.livingAreaSqm ?? llm.livingAreaSqm,
              rooms: fields.rooms ?? llm.rooms,
              units: fields.units ?? llm.units,
            }
            cacheable = true
          }
        } else if (llmConfig) {
          // Per-run or per-platform LLM cap hit: cache the rules-only result
          // anyway so the listing shows *something* immediately. Its source
          // stays 'rules' with confidence 'low', so needsLlmRetry picks it up
          // again once an LLM slot frees up on a later run. Leaving it
          // uncached instead starved huge platforms (IT: 14k listings ÷ 300
          // calls/run) of any extraction data for months.
          cacheable = detailOk
        } else {
          // LLM disabled entirely: cache the rules result if we had real text
          // to work with, else leave it for a later run to retry.
          cacheable = detailOk
        }

        if (!cacheable) continue

        // Two-way photo pipeline (platform/externalId guard applies to both — the
        // API endpoint enforces the same shape, so files under an unsafe path
        // would be unreachable anyway):
        //   a) Native image URLs — from the crawler's foto attachments (AT
        //      edikte.justiz.gv.at JPGs, Biddit JPEGs) and from `photoUrls`
        //      (gallery URLs crawlers collect beyond the thumbnail). We mirror
        //      them into the local image cache so the browser fetches from us,
        //      not the upstream on every card.
        //   b) When (a) yields nothing (no native URLs, or all downloads
        //      failed), mine the best PDF for embedded rasters — but only if
        //      the listing didn't already declare foto attachments, since
        //      Gutachten photos are a different set from the listing's own
        //      Foto.pdf/JPG and we don't want to overwrite them.
        // Wrapped in try/catch so a disk-full or subprocess failure on one
        // listing can't reject the whole Promise.all — mirrors the enrichOne
        // pattern above.
        let photos: string[] = []
        const prevEntry = cache[key]
        if (prevEntry) {
          // needsLlmRetry re-run (a cache entry here means exactly that): the
          // photo pipeline already ran when the rules-only entry was cached.
          // The mirrored files are content-addressed and still on disk — reuse
          // the result instead of re-downloading every gallery / re-mining the
          // PDF on every capped run (with the LLM cap at 300/run, large
          // platforms stay in retry for many runs). First runs and entries
          // never cached before still go through the full pipeline below.
          photos = prevEntry.photos ?? []
        } else if (isSafePathSegment(a.platform) && isSafePathSegment(a.externalId)) {
          const destDir = join(IMAGES_DIR, a.platform, a.externalId)
          const nativeFotoUrls = [
            ...a.attachments
              .filter(
                (att) =>
                  att.kind === 'photo' &&
                  /^https?:\/\/.*\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(att.proxyUrl),
              )
              .map((att) => att.proxyUrl),
            ...(a.photoUrls ?? []),
          ]
          try {
            if (nativeFotoUrls.length > 0) {
              photos = await downloadNativeImages([...new Set(nativeFotoUrls)], { destDir })
            }
            if (photos.length === 0 && bestPdf && a.photoCount === 0) {
              photoExtractions++
              photos = await extractPdfPhotos(bestPdf.proxyUrl, { destDir })
            }
            photosTotal += photos.length
          } catch (err) {
            console.warn(
              `[enrich] photo extraction failed for ${a.platform}:${a.externalId}: ${(err as Error).message}`,
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
      if (a.marketValueEur != null) continue
      const hit = vwCache[cacheKey(a.platform, a.externalId)]
      if (!hit) continue
      a.marketValueEur = hit.marketValueEur
      a.marketValueText = hit.marketValueText
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
