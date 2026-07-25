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
import type { Attachment, Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto } from '~/lib/photo'
import { crawlAll, platforms } from '~/server/crawlers/registry'
import { readAuctionSnapshot, writeAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { deriveMarketValueEur, getRates } from '~/server/utils/exchange-rate'
import { extractByRules } from '~/server/utils/extract/rules'
import { extractByLlm, resolveLlmConfig, type LlmInput, type PhotoCuration } from '~/server/utils/extract/llm'
import { buildDocumentLlmParts } from '~/server/utils/extract/pdf-documents'
import { isLlmBatchPending, submitGeminiBatch } from '~/server/utils/extract/gemini-batch'
import { getPool } from '~/server/utils/db'
import { DEFAULT_LLM_MAX_TOKENS, getLlmMaxTokens, getLlmProviderOverride } from '~/server/utils/app-settings'
import { mergeLlmResult } from '~/server/utils/extract/merge-llm-result'
import { downloadNativeImages } from '~/server/utils/extract/native-images'
import { extractPdfPhotos } from '~/server/utils/extract/pdf-images'
import { pdfPagesToBase64Jpeg } from '~/server/utils/extract/pdf-render'
import { fetchPdfBuffer, pdfToText, pickBestPdf, pickRelevantPdfs } from '~/server/utils/extract/pdf-text'
import {
  applyExtractionToAuctions,
  type ExtractionCache,
  readExtractionCache,
  writeExtractionCache,
} from '~/server/utils/extraction-cache'
import { imagesBucketConfigured, mimeTypeFor, uploadImage } from '~/server/utils/image-storage'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { archiveAuction, archiveDocument } from '~/server/utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { applyDescriptionMarketValue } from '~/server/utils/description-market-value'

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
// Give up retrying a listing whose LLM request keeps *failing* (network/proxy
// error, timeout) after this many attempts. Without a bound, such a listing
// never gets a cache entry and so re-consumes an LLM slot on every run forever,
// starving healthy listings of the per-run budget. A few retries still absorb
// transient proxy blips.
const MAX_LLM_FAILURES = 3
// Give up retrying a listing whose photo pipeline (native download / PDF
// extraction) keeps *throwing* after this many attempts — same rationale as
// MAX_LLM_FAILURES. A listing that completes an attempt but legitimately has
// no usable photos stops retrying immediately (photosCheckedAt gets set),
// this bound only guards against persistent errors.
const MAX_PHOTO_FAILURES = 3
// Cap on candidate photos sent to the LLM for curation per document — a
// Gutachten with dozens of embedded rasters would otherwise blow the token
// budget for one extraction call.
const MAX_CANDIDATE_PHOTOS = 8
// Cap on photos mined across *all* candidate PDFs for one listing. Gutachten
// are frequently split into several attachments (Teil 1/Teil 2/Anlagen) with
// photos scattered across them, so mining stops only once this many are found
// or every candidate has been tried — not after the first PDF.
const MAX_PDF_PHOTOS_PER_LISTING = 12

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

async function readLlmConfig(): Promise<ReturnType<typeof resolveLlmConfig>> {
  const c = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string; maxPerRun?: string }
    | undefined
  const db = getPool()
  const maxTokens = db
    ? await getLlmMaxTokens(db, 'extraction').catch(() => DEFAULT_LLM_MAX_TOKENS.extraction)
    : DEFAULT_LLM_MAX_TOKENS.extraction
  const override = db ? await getLlmProviderOverride(db).catch(() => null) : null
  return resolveLlmConfig(override ?? c, { maxTokens })
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

export async function runEnrich() {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()
    const previousSnapshot = await readAuctionSnapshot()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))
    const llmConfig = await readLlmConfig()
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
    // condition/features/yearBuilt/lastRenovationYear/insights/marketValueEur
    // are LLM-only fields added after this cache existed: `undefined` means
    // "never checked" (an entry written before the field existed, or a
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
          hit.insights === undefined ||
          hit.planningNotes === undefined ||
          hit.documentSummary === undefined ||
          hit.marketValueEur === undefined) &&
        (hit.llmFailures ?? 0) < MAX_LLM_FAILURES &&
        !isLlmBatchPending(hit)
      )
    }
    // A prior attempt may never have run the actual photo pipeline (the
    // `if (priorEntry)` reuse branch below only carries `priorEntry.photos`
    // forward) or may have thrown before completing. `photosCheckedAt` unset
    // means "never attempted"; bounded by MAX_PHOTO_FAILURES so a listing
    // whose PDF/URLs genuinely hold no usable photos doesn't retry forever.
    // Entries that already have photos need no backfill regardless of the
    // marker.
    const needsPhotoBackfill = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      return (
        hit != null &&
        !hit.photos?.length &&
        hit.photosCheckedAt == null &&
        (hit.photoFailures ?? 0) < MAX_PHOTO_FAILURES
      )
    }
    const eligible = result.auctions.filter(
      (a) =>
        !cache[cacheKey(a.platform, a.externalId)] ||
        needsEnrich(a) ||
        needsLlmRetry(a) ||
        needsLlmFieldsBackfill(a) ||
        needsPhotoBackfill(a),
    )
    const todo = interleaveByPlatform(eligible)
    const maxLlmPerRun = readMaxLlmPerRun()
    console.log(
      `[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)enrich · llm=${llmConfig ? `${llmConfig.model} (maxTokens=${llmConfig.maxTokens})` : 'off'} maxLlmPerRun=${maxLlmPerRun}`,
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
        const extractionMissing =
          !priorEntry || needsLlmRetry(a) || needsLlmFieldsBackfill(a) || needsPhotoBackfill(a)

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
            applyDescriptionMarketValue(a)
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
          planningNotes: priorEntry?.planningNotes,
          documentSummary: priorEntry?.documentSummary,
          marketValueEur: priorEntry?.marketValueEur,
          marketValueText: priorEntry?.marketValueText,
        }
        const mergedConfident =
          rules.confident ||
          (fields.propertyType != null &&
            fields.propertyType !== 'sonstiges' &&
            (fields.landAreaSqm != null || fields.livingAreaSqm != null))
        let cacheable: boolean
        const bestPdf = pickBestPdf(a.attachments)
        const relevantPdfs = pickRelevantPdfs(a.attachments)
        const documentPdfs = relevantPdfs.length > 0
          ? relevantPdfs
          : bestPdf
            ? [bestPdf]
            : []
        const pdfIdentity = {
          platform: a.platform,
          country: a.country,
          region: a.region,
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
        const pdfTextEntries = usingNativeDoc
          ? []
          : await Promise.all(
              documentPdfs.map(async (pdf) => ({
                pdf,
                text: await pdfToText(pdf.proxyUrl, { identity: pdfIdentity, capturedAt: at }),
              })),
            )
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
        // Carried forward by default (matches priorEntry); overwritten below
        // only when the photo pipeline actually runs this iteration.
        let photosCheckedAt = priorEntry?.photosCheckedAt
        let photoFailures = priorEntry?.photoFailures ?? 0
        // Whether the photo pipeline actually ran this iteration (success or
        // failure) — distinct from cacheable below, so a photo-only backfill
        // outcome still gets persisted even when rules are unconfident and
        // the LLM is disabled/capped/failed (see cacheable assignments below).
        let photoPipelineRan = false
        if (priorEntry && !needsPhotoBackfill(a)) {
          // A re-run (needsLlmRetry / needsLlmFieldsBackfill — a cache entry
          // here means one of those, or needsEnrich alone with photos already
          // checked): the photo pipeline already ran when this entry was
          // first cached (or a later backfill pass). The mirrored files are
          // content-addressed and still on disk — reuse the result instead of
          // re-downloading every gallery / re-mining the PDF on every retry
          // pass. First runs and entries never checked before go through the
          // full pipeline below instead. Normalize while reusing: a legacy
          // prior entry may hold bare filename strings, and re-persisting
          // them raw would perpetuate the old shape instead of upgrading it.
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
          // First-ever entry, or a backfill retry (needsPhotoBackfill): the
          // predicate only lets a listing in here when it has no photos yet,
          // so there's nothing on disk worth preserving from priorEntry.
          const destDir = join(IMAGES_DIR, a.platform, a.externalId)
          photoPipelineRan = true
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
          // Gutachten are often split across several attachments (Teil 1,
          // Teil 2, Anlagen); the property photos can end up in any of them,
          // not just the one pickBestPdf() picks for text extraction. Try
          // appraisal PDFs first, then the Exposé/brochure, until the cap is
          // hit or every candidate has been mined.
          const pdfPhotoCandidates = [
            ...a.attachments.filter((att) => att.kind === 'appraisal'),
            ...a.attachments.filter((att) => att.kind === 'brochure'),
          ]
          try {
            if (nativeFotoUrls.length > 0) {
              photos = await downloadNativeImages([...new Set(nativeFotoUrls)], { destDir })
            }
            if (photos.length === 0 && pdfPhotoCandidates.length > 0 && a.photoCount === 0) {
              let pdfMiningFailed = false
              for (const pdf of pdfPhotoCandidates) {
                if (photos.length >= MAX_PDF_PHOTOS_PER_LISTING) break
                photoExtractions++
                try {
                  const found = await extractPdfPhotos(pdf.proxyUrl, {
                    destDir,
                    maxPhotos: MAX_PDF_PHOTOS_PER_LISTING - photos.length,
                  })
                  for (const name of found) if (!photos.includes(name)) photos.push(name)
                } catch (err) {
                  pdfMiningFailed = true
                  console.warn(
                    `[enrich] photo extraction failed for ${a.platform}:${a.externalId} (${pdf.proxyUrl}): ${(err as Error).message}`,
                  )
                }
              }
              // Only surface as a retryable failure when nothing was found at
              // all and at least one candidate errored — a confirmed-empty
              // pass across every candidate should still set photosCheckedAt
              // below, same as the pre-existing single-PDF behavior.
              if (photos.length === 0 && pdfMiningFailed) {
                throw new Error(`photo extraction failed for all ${pdfPhotoCandidates.length} candidate PDF(s)`)
              }
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
            // Completed without throwing — "checked", regardless of whether
            // any photos were actually found (a legitimately photo-less
            // listing/PDF stops being retried from here on).
            photosCheckedAt = at
            photoFailures = 0
          } catch (err) {
            photoFailures++
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
            const nativeDocuments = (
              await Promise.all(documentPdfs.map(async (pdf) => {
                const bytes = await fetchPdfBuffer(pdf.proxyUrl)
                if (!bytes) return null
                await archiveDocument(bytes, 'application/pdf', pdfIdentity, pdf.proxyUrl, at)
                return {
                  source: pdf,
                  label: pdf.label || pdf.filename,
                  data: bytes.toString('base64'),
                }
              }))
            ).filter((doc): doc is { source: Attachment; label: string; data: string } => doc != null)
            const documentParts = await buildDocumentLlmParts(nativeDocuments, { native: true })
            batchItems.push({
              key,
              input: {
                title: a.title,
                description: a.description,
                ...documentParts,
                candidateImages,
              },
            })
            // Same fallback as the per-run/per-platform cap-hit branch below
            // — cache the rules-only result now so the listing shows
            // *something* immediately; llm-batch-poll.ts merges the LLM
            // contribution once the submitted job completes.
            cacheable = mergedConfident || detailOk || photoPipelineRan
          } else {
            // A short/empty pdftotext result on an actual attachment usually
            // means the Gutachten PDF is a scanned image, not real text —
            // render a bounded page range and let the LLM read it visually.
            const documentParts = await buildDocumentLlmParts(
              pdfTextEntries.map(({ pdf, text }) => ({
                source: pdf,
                label: pdf.label || pdf.filename,
                text,
              })),
              {
                native: false,
                renderPages: (pdf, maxPages) => pdfPagesToBase64Jpeg(pdf.proxyUrl, { maxPages }),
              },
            )
            const llm = await extractByLlm(
              { title: a.title, description: a.description, ...documentParts, candidateImages },
              llmConfig,
            )
            // Curation only applies to the photos actually offered this call
            // (a fresh first-run download/extraction) — a re-run's
            // curatedPhotos came from priorEntry and were never sent as
            // candidateImages.
            if (llm && curatedPhotos && candidateImages?.length && llm.photoCuration.length) {
              curatedPhotos = applyPhotoCuration(curatedPhotos, llm.photoCuration)
            }
            const merged = {
              ...mergeLlmResult(priorEntry, { ...fields, confident: mergedConfident }, llm, at, curatedPhotos),
              // Override mergeLlmResult's priorEntry-carried defaults with this
              // iteration's actual photo-attempt outcome (explicit `undefined`
              // clears a stale value rather than leaving the carried-forward one).
              photosCheckedAt,
              photoFailures: photoFailures > 0 ? photoFailures : undefined,
            }
            // Same rationale as the cap-hit/disabled branches below: a failed
            // request only caches when detail/rules already gave us something
            // — unless the photo pipeline ran, in which case that outcome
            // (photosCheckedAt/photoFailures) still needs to be persisted.
            cacheable = llm !== null || mergedConfident || detailOk || photoPipelineRan
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
          cacheable = mergedConfident || detailOk || photoPipelineRan
        } else {
          // LLM disabled entirely: cache the rules result if we had real text
          // to work with, else leave it for a later run to retry.
          cacheable = mergedConfident || detailOk || photoPipelineRan
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
          photosCheckedAt,
          photoFailures: photoFailures > 0 ? photoFailures : undefined,
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
