// Crawls every registered region and extracts structured fields (property type
// + sizes) from each listing, persisting the result (Postgres, see
// extraction-cache.ts). Idempotent: ids already in the cache are skipped, so
// the first run does the work and subsequent runs only process newly-listed
// auctions.
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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto } from '~/lib/photo'
import { crawlAll, platforms } from '../crawlers/registry'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { upsertCurrentAuctions } from '../utils/current-auctions'
import { deriveMarketValueEur, getRates } from '../utils/exchange-rate'
import { extractByRules } from '../utils/extract/rules'
import { extractByLlm, type LlmConfig, type LlmInput, type PhotoCuration } from '../utils/extract/llm'
import { isLlmBatchPending, submitGeminiBatch } from '../utils/extract/gemini-batch'
import { mergeLlmResult } from '../utils/extract/merge-llm-result'
import { downloadNativeImages } from '../utils/extract/native-images'
import { extractPdfPhotos } from '../utils/extract/pdf-images'
import { pdfPagesToBase64Jpeg } from '../utils/extract/pdf-render'
import { fetchPdfBuffer, pdfToText, pickBestPdf } from '../utils/extract/pdf-text'
import {
  applyExtractionToAuctions,
  type ExtractionCache,
  readExtractionCache,
  writeExtractionCache,
} from '../utils/extraction-cache'
import { imagesBucketConfigured, mimeTypeFor, uploadImage } from '../utils/image-storage'
import { interleaveByPlatform } from '../utils/interleave-by-platform'
import { isSafePathSegment } from '../utils/path-segment'
import { archiveAuction, archiveDocument } from '../utils/raw-archive'
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
// Below this, pdftotext's output is almost certainly not the Gutachten's real
// content but leftover header/footer noise from a scanned-image PDF (~12% of
// sampled DE PDFs fall under this). Below the threshold, render the page and
// let the LLM read it visually instead of failing to extract from noise.
const SCANNED_PDF_TEXT_THRESHOLD = 200
// Give up retrying a listing whose LLM request keeps *failing* (network/proxy
// error, timeout) after this many attempts. Without a bound, such a listing
// never gets a cache entry and so re-consumes an LLM slot on every run forever,
// starving healthy listings of the per-run budget. A few retries still absorb
// transient proxy blips.
const MAX_LLM_FAILURES = 3
// Cap on candidate photos sent to the LLM for curation per document — a
// Gutachten with dozens of embedded rasters would otherwise blow the token
// budget for one extraction call.
const MAX_CANDIDATE_PHOTOS = 8

/** Overlays the LLM's index-based curation onto the default-categorized
 *  photo list, keeping each entry's `file` — the LLM never sees real
 *  filenames, only its position in the `candidateImages` that were sent
 *  (see `LlmInput.candidateImages`). An index outside `base` (stale/
 *  hallucinated) is ignored rather than throwing. */
function applyPhotoCuration(base: CuratedPhoto[], curation: PhotoCuration[]): CuratedPhoto[] {
  if (!curation.length) return base
  const out = [...base]
  for (const c of curation) {
    const prior = out[c.photoIndex]
    if (!prior) continue
    out[c.photoIndex] = { file: prior.file, category: c.category, caption: c.caption, isPropertyPhoto: c.isPropertyPhoto }
  }
  return out
}

function readLlmConfig(): LlmConfig | null {
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string; maxPerRun?: string }
    | undefined
  if (!c?.baseUrl) return null
  const provider = c.provider === 'claude-proxy' || c.provider === 'gemini-native' ? c.provider : 'openai-compatible'
  return {
    provider,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey || undefined,
    model: c.model || (provider === 'gemini-native' ? 'gemini-flash-latest' : 'claude-haiku-4-5'),
  }
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
      return (
        hit?.source === 'rules' &&
        hit.confidence === 'low' &&
        (hit.llmFailures ?? 0) < MAX_LLM_FAILURES &&
        !isLlmBatchPending(hit)
      )
    }
    // condition/features/yearBuilt/lastRenovationYear/insights are LLM-only
    // fields added after this cache existed: `undefined` means "never
    // checked" (an entry written before the field existed, or a
    // mergedConfident entry from before this backfill shipped), `null`/`[]`
    // means "checked, nothing found". Bounded by MAX_LLM_FAILURES like
    // needsLlmRetry so a persistently-failing listing doesn't re-consume an
    // LLM slot every run forever.
    const needsLlmFieldsBackfill = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      return (
        llmConfig != null &&
        hit != null &&
        (hit.condition === undefined ||
          hit.features === undefined ||
          hit.yearBuilt === undefined ||
          hit.lastRenovationYear === undefined ||
          hit.insights === undefined) &&
        (hit.llmFailures ?? 0) < MAX_LLM_FAILURES &&
        !isLlmBatchPending(hit)
      )
    }
    const eligible = result.auctions.filter(
      (a) =>
        !cache[cacheKey(a.platform, a.externalId)] ||
        needsEnrich(a) ||
        needsLlmRetry(a) ||
        needsLlmFieldsBackfill(a),
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
    // Entries added/changed since the last flush. writeExtractionCache only
    // upserts what's actually dirty, not the whole (ever-growing) cache — see
    // extraction-cache.ts. Swapped out for a fresh object right before each
    // flush call, synchronously (no `await` in between), so no writer can add
    // to a batch that's already been handed off.
    let dirty: ExtractionCache = {}
    // LLM inputs collected for gemini-native's batch submission (see
    // gemini-batch.ts) — one submitGeminiBatch call for the whole run instead
    // of a synchronous generateContent call per item. Unused (stays empty)
    // for the other providers, which still call extractByLlm synchronously.
    const batchItems: { key: string; input: LlmInput }[] = []

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
        const priorEntry = cache[key]
        const extractionMissing = !priorEntry || needsLlmRetry(a) || needsLlmFieldsBackfill(a)

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
        const fields = {
          propertyType: rules.propertyType,
          landAreaSqm: a.sourceLandAreaSqm ?? rules.landAreaSqm,
          livingAreaSqm: a.sourceLivingAreaSqm ?? rules.livingAreaSqm,
          rooms: a.sourceRooms ?? rules.rooms,
          units: rules.units,
          // Structured platform value (e.g. si's Kaution) beats a regex guess,
          // same precedence as the source*Sqm fields above. Independent of the
          // LLM branch below — an explicit amount stated in prose doesn't need
          // an LLM call to find, so this fills in even for mergedConfident entries.
          securityDeposit: a.sourceSecurityDeposit ?? rules.securityDeposit,
          // LLM-only — stays undefined unless a successful LLM call below
          // finds rules/structured values NOT already confident (see the
          // `!mergedConfident` branch): biddingNotes is a rare catch-all, not
          // a universal per-listing fact like condition/features/insights, so
          // a confident entry doesn't get it overwritten even though the LLM
          // call itself still runs for those other fields.
          biddingNotes: undefined as string | null | undefined,
          // LLM-only — undefined until a successful LLM call below sets them;
          // carries a prior partial result forward on a re-run (shouldn't
          // normally happen since they're set together, but keeps this idempotent).
          condition: priorEntry?.condition,
          features: priorEntry?.features,
          yearBuilt: priorEntry?.yearBuilt,
          lastRenovationYear: priorEntry?.lastRenovationYear,
          renovationNotes: priorEntry?.renovationNotes,
          insights: priorEntry?.insights,
        }
        const mergedConfident =
          rules.confident ||
          (fields.propertyType != null &&
            fields.propertyType !== 'sonstiges' &&
            (fields.landAreaSqm != null || fields.livingAreaSqm != null))
        let cacheable: boolean
        const bestPdf = pickBestPdf(a.attachments)
        const pdfIdentity = {
          platform: a.platform,
          country: a.country,
          externalId: a.externalId,
          caseNumber: a.caseNumber,
          authority: a.authority,
        }
        // gemini-native reads the PDF's raw bytes directly (native document
        // understanding, see gemini-batch.ts) — skip pdftotext for it
        // entirely, fetching bytes instead once this item is actually about
        // to be batch-submitted (below, inside the LLM-budget-gated block).
        const usingNativeDoc = llmConfig?.provider === 'gemini-native'
        // Fetching (and archiving) the best appraisal PDF happens here
        // regardless of whether rules already found a confident result — the
        // archive's purpose is preserving the source document for
        // re-processing, independent of today's extraction outcome. The
        // on-disk text cache in pdfToText means this is a no-op fetch/archive
        // on any run after the first for a given PDF.
        const pdfText =
          bestPdf && !usingNativeDoc ? await pdfToText(bestPdf.proxyUrl, { identity: pdfIdentity, capturedAt: at }) : null

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
        // Runs *before* the LLM call below (unlike the pre-C.6 shape) so a
        // freshly downloaded/extracted photo set can be offered to the LLM
        // for curation in the same call — see freshPhotoFiles/candidateImages.
        let curatedPhotos: CuratedPhoto[] | undefined
        let freshPhotoFiles: string[] | undefined
        let freshPhotoDestDir: string | null = null
        if (priorEntry) {
          // A re-run (needsLlmRetry / needsLlmFieldsBackfill — a cache entry
          // here means exactly one of those): the photo pipeline already ran
          // when this entry was first cached. The mirrored files are
          // content-addressed and still on disk — reuse the result instead of
          // re-downloading every gallery / re-mining the PDF on every retry
          // pass. First runs and entries never cached before still go through
          // the full pipeline below. Normalize while reusing: a legacy prior
          // entry may hold bare filename strings, and re-persisting them raw
          // would perpetuate the old shape instead of upgrading it.
          curatedPhotos = priorEntry.photos?.map(normalizePhoto)
          // Unlike a fully-curated prior entry, one whose LLM fields never got
          // a successful call (cap hit / request failure on the run that
          // downloaded these photos) never had a curation opportunity —
          // offer the cached files again as candidateImages so this backfill
          // can still curate them instead of leaving them uncategorized forever.
          if (
            needsLlmFieldsBackfill(a) &&
            curatedPhotos?.length &&
            isSafePathSegment(a.platform) &&
            isSafePathSegment(a.externalId)
          ) {
            freshPhotoFiles = curatedPhotos.map((p) => p.file)
            freshPhotoDestDir = join(IMAGES_DIR, a.platform, a.externalId)
          }
        } else if (isSafePathSegment(a.platform) && isSafePathSegment(a.externalId)) {
          const destDir = join(IMAGES_DIR, a.platform, a.externalId)
          // The deterministic pipeline yields bare filenames; they become
          // CuratedPhoto entries (category defaults to 'sonstiges' unless the
          // LLM call below curates them for real).
          let photos: string[] = []
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
            // Mirror the freshly written files into the images bucket (WP-4) so
            // /api/auction-image can fall back to Supabase once the local cache
            // is gone. Best-effort — uploadImage never throws and no-ops
            // without a configured bucket; skip re-reading the files off disk
            // entirely in that (default) case.
            if (imagesBucketConfigured()) {
              for (const name of photos) {
                const bytes = await readFile(join(destDir, name))
                await uploadImage(bytes, `${a.platform}/${a.externalId}/${name}`)
              }
            }
          } catch (err) {
            console.warn(
              `[enrich] photo extraction failed for ${a.platform}:${a.externalId}: ${(err as Error).message}`,
            )
          }
          curatedPhotos = photos.length > 0 ? photos.map(normalizePhoto) : undefined
          if (photos.length > 0) {
            freshPhotoFiles = photos
            freshPhotoDestDir = destDir
          }
        }

        const platformLlmCalls = llmCallsByPlatform.get(a.platform) ?? 0
        // Rules/structured values are a merge input, not a gate: even a
        // mergedConfident listing still gets an LLM call (budget permitting)
        // so it also picks up condition/features/yearBuilt/insights/photo
        // curation — the earlier "confident → skip LLM entirely" fast path
        // left those fields unset until a delayed backfill run.
        if (llmConfig && llmCalls < maxLlmPerRun && platformLlmCalls < llmCapPerPlatform) {
          llmCalls++
          llmCallsByPlatform.set(a.platform, platformLlmCalls + 1)
          // Offer a capped subset of a freshly downloaded/extracted photo set
          // for real curation — capped so a Gutachten with dozens of embedded
          // rasters doesn't blow the token budget. Built lazily here (not
          // above) so a cap-hit/no-LLM run never pays for the base64 encode.
          let candidateImages: { label: string; mimeType: string; data: string }[] | undefined
          if (freshPhotoFiles?.length && freshPhotoDestDir) {
            const destDir = freshPhotoDestDir
            const capped = freshPhotoFiles.slice(0, MAX_CANDIDATE_PHOTOS)
            try {
              candidateImages = await Promise.all(
                capped.map(async (name) => ({
                  label: name,
                  mimeType: mimeTypeFor(name),
                  data: (await readFile(join(destDir, name))).toString('base64'),
                })),
              )
            } catch (err) {
              console.warn(
                `[enrich] candidate image read failed for ${a.platform}:${a.externalId}: ${(err as Error).message}`,
              )
            }
          }

          if (usingNativeDoc) {
            // Batch mode (see gemini-batch.ts): collect this item's LLM
            // input for one submitGeminiBatch call after the whole worker
            // pool finishes instead of a synchronous generateContent call —
            // the Free-Tier rate limit that motivated this migration can't
            // sustain hundreds of synchronous calls in a couple of minutes.
            // Fetch+archive the raw PDF bytes only now (not unconditionally
            // like pdfText above) so a cap-skipped item under gemini-native
            // doesn't re-hit the upstream every single run — it archives
            // once it actually gets a slot.
            let pdfBytes: string | null = null
            if (bestPdf) {
              const bytes = await fetchPdfBuffer(bestPdf.proxyUrl)
              if (bytes) {
                await archiveDocument(bytes, 'application/pdf', pdfIdentity, bestPdf.proxyUrl, at)
                pdfBytes = bytes.toString('base64')
              }
            }
            batchItems.push({ key, input: { title: a.title, description: a.description, pdfBytes, candidateImages } })
            // Same fallback as the per-run/per-platform cap-hit branch below
            // — cache the rules-only result now so the listing shows
            // *something* immediately; llm-batch-poll.ts merges the LLM
            // contribution once the submitted job completes.
            cacheable = mergedConfident || detailOk
          } else {
            // A short/empty pdftotext result on an actual attachment usually
            // means the Gutachten PDF is a scanned image, not real text —
            // render its first page and let the LLM read it visually instead.
            const pdfPageImages =
              bestPdf && (!pdfText || pdfText.trim().length < SCANNED_PDF_TEXT_THRESHOLD)
                ? await pdfPagesToBase64Jpeg(bestPdf.proxyUrl)
                : null
            const llm = await extractByLlm(
              { title: a.title, description: a.description, pdfText, pdfPageImages, candidateImages },
              llmConfig,
            )
            // Curation only applies to the photos actually offered this call
            // (a fresh first-run download/extraction) — a re-run's
            // curatedPhotos came from priorEntry and were never sent as
            // candidateImages.
            if (llm && curatedPhotos && candidateImages?.length && llm.photoCuration.length) {
              curatedPhotos = applyPhotoCuration(curatedPhotos, llm.photoCuration)
            }
            const merged = mergeLlmResult(priorEntry, { ...fields, confident: mergedConfident }, llm, at, curatedPhotos)
            // Same rationale as the cap-hit/disabled branches below: a failed
            // request only caches when detail/rules already gave us something.
            cacheable = llm !== null || mergedConfident || detailOk
            if (cacheable) {
              cache[key] = merged
              dirty[key] = merged
              cached++
              if (merged.confidence === 'high') confident++
              if (cached % FLUSH_EVERY === 0) {
                const toFlush = dirty
                dirty = {}
                const ok = await writeExtractionCache(toFlush)
                if (!ok) dirty = { ...toFlush, ...dirty }
              }
            }
            continue
          }
        } else if (llmConfig) {
          // Per-run or per-platform LLM cap hit: cache the rules result
          // anyway so the listing shows *something* immediately. When rules
          // aren't confident, source stays 'rules' with confidence 'low' so
          // needsLlmRetry picks it up again once an LLM slot frees up;
          // condition/features/yearBuilt/insights stay unset either way so
          // needsLlmFieldsBackfill retries them too. Leaving it uncached
          // instead starved huge platforms (IT: 14k listings ÷ 300
          // calls/run) of any extraction data for months.
          cacheable = mergedConfident || detailOk
        } else {
          // LLM disabled entirely: cache the rules result if we had real text
          // to work with, else leave it for a later run to retry.
          cacheable = mergedConfident || detailOk
        }

        if (!cacheable) continue

        const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
        const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
        // No LLM attempt was made on this path (batch-collect / cap-hit /
        // disabled) — carry the failure counter forward unchanged.
        const prevFailures = cache[key]?.llmFailures ?? 0
        const entry: AuctionExtraction = {
          ...fields,
          source: 'rules',
          confidence: hasType && hasArea ? 'high' : 'low',
          photos: curatedPhotos,
          at,
          ...(prevFailures > 0 ? { llmFailures: prevFailures } : {}),
        }
        cache[key] = entry
        dirty[key] = entry
        cached++
        if (entry.confidence === 'high') confident++
        if (cached % FLUSH_EVERY === 0) {
          const toFlush = dirty
          dirty = {}
          const ok = await writeExtractionCache(toFlush)
          // On a failed upsert, re-merge the batch into dirty so the next
          // flush retries it instead of silently losing it from Postgres.
          if (!ok) dirty = { ...toFlush, ...dirty }
        }
      }
    }
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker))

    if (batchItems.length > 0 && llmConfig) {
      const jobName = await submitGeminiBatch(batchItems, llmConfig, 'enrich')
      if (jobName) {
        // Mark every submitted item's already-cached rules-only entry with
        // the job name so needsLlmRetry/needsLlmFieldsBackfill don't
        // re-submit it to a second job while this one is still in flight
        // (see AuctionExtraction.llmBatchJob / isLlmBatchPending).
        for (const item of batchItems) {
          const priorItemEntry = cache[item.key]
          if (!priorItemEntry) continue
          const marked = { ...priorItemEntry, llmBatchJob: jobName }
          cache[item.key] = marked
          dirty[item.key] = marked
        }
        console.log(`[enrich] submitted Gemini batch ${jobName} with ${batchItems.length} items`)
      } else {
        console.warn(`[enrich] Gemini batch submission failed for ${batchItems.length} items — will retry next run`)
      }
    }

    if (Object.keys(dirty).length > 0) await writeExtractionCache(dirty)

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
    // Structured Postgres mirror for fast SQL filter queries (Daten-API, admin
    // tooling) — additive, no-op without NUXT_DATABASE_URL. See
    // server/utils/current-auctions.ts.
    await upsertCurrentAuctions(result.auctions, at)

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
