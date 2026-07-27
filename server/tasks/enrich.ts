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
// after server startup via server/plugins/enrich-bootstrap.ts. Batch LLM
// submission is opt-in either per task payload (`{ batch: true }`) or via the
// admin LLM provider setting; the persisted default is still synchronous.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { normalizePhoto } from '~/lib/photo'
import { crawlAll, platforms } from '~/server/crawlers/registry'
import { readAuctionSnapshot, writeAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { deriveMarketValueEur, getRates } from '~/server/utils/exchange-rate'
import { extractByRules } from '~/server/utils/extract/rules'
import { extractByLlm, type LlmInput, type PhotoCuration } from '~/server/utils/extract/llm'
import { MAX_LLM_FAILURES, readExtractionLlmConfig } from '~/server/utils/extract/llm-task-config'
import {
  isLlmBatchPending,
  isLlmBatchProviderBroken,
  submitLlmBatch,
  supportsLlmBatch,
  supportsNativeBatchDocuments,
} from '~/server/utils/extract/llm-batch'
import { readLlmExecutionMode } from '~/server/utils/app-settings'
import { mergeLlmResult } from '~/server/utils/extract/merge-llm-result'
import { downloadNativeImages } from '~/server/utils/extract/native-images'
import { extractDocumentPhotos } from '~/server/utils/extract/document-images'
import {
  prepareArchivedLlmDocuments,
  prepareLiveLlmDocuments,
  readArchivedAuction,
} from '~/server/utils/extract/llm-documents'
import {
  applyExtractionToAuctions,
  type ExtractionCache,
  readExtractionCache,
  writeExtractionCache,
} from '~/server/utils/extraction-cache'
import { imagesBucketConfigured, mimeTypeFor, uploadImage } from '~/server/utils/image-storage'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { isSafePathSegment } from '~/server/utils/path-segment'
import {
  archiveAuction,
  archiveDocumentSet,
  type ArchivedDocumentSetResult,
} from '~/server/utils/raw-archive'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { applyDescriptionMarketValue } from '~/server/utils/description-market-value'
import { normalizeAuctionDescription, normalizeAuctionDescriptions } from '~/server/utils/description-normalization'

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
// Give up retrying a listing whose photo pipeline (native download / document
// extraction) keeps *throwing* after this many attempts — same rationale as
// MAX_LLM_FAILURES. A listing that completes an attempt but legitimately has
// no usable photos stops retrying immediately (photosCheckedAt gets set),
// this bound only guards against persistent errors.
const MAX_PHOTO_FAILURES = 3
const PHOTO_PIPELINE_VERSION = 2
const KRONOFOGDEN_GALLERY_PHOTO_PIPELINE_VERSION = 3
// Cap on candidate photos sent to the LLM for curation per document — a
// Gutachten with dozens of embedded rasters would otherwise blow the token
// budget for one extraction call.
const MAX_CANDIDATE_PHOTOS = 8
// Cap on photos mined across *all* candidate documents for one listing.
// Gutachten/Exposés are frequently split across PDF/DOCX/HTML attachments
// (Teil 1, Teil 2, Anlagen), so mining stops only once this many are found
// or every candidate has been tried — not after the first document.
const MAX_DOCUMENT_PHOTOS_PER_LISTING = 12

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

function readMaxLlmPerRun(): number {
  const raw = Number((useRuntimeConfig().extractLlm as { maxPerRun?: string })?.maxPerRun)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LLM_PER_RUN
}

// Guards against overlapping runs: a cold-start bootstrap run (many detail
// fetches + PDF work) can still be active when the cron tick fires. Two
// concurrent runs would double-fetch details and race on the snapshot write.
let running = false

export interface EnrichOptions {
  /** Submit eligible LLM work via the configured provider's Batch API.
   *  Default false: provider selection alone never changes sync vs async
   *  behavior. */
  batch?: boolean
}

export function hasDocumentSetChanged(
  priorEntry: AuctionExtraction | undefined,
  currentDocumentSet: ArchivedDocumentSetResult | null,
): boolean {
  if (!priorEntry || !currentDocumentSet) return false
  return priorEntry.documentSetHash !== currentDocumentSet.setHash
}

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions and extract property type + sizes (rules + LLM fallback) for new listings into the disk cache.',
  },
  async run(event) {
    if (running) {
      console.warn('[enrich] previous run still in progress — skipping')
      return { result: undefined }
    }
    running = true
    try {
      return await runEnrich((event?.payload ?? {}) as EnrichOptions)
    } finally {
      running = false
    }
  },
})

export async function runEnrich(opts: EnrichOptions = {}) {
    const startedAt = Date.now()
    console.log('[enrich] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const cache = await readExtractionCache()
    const previousSnapshot = await readAuctionSnapshot()
    const byPlatform = new Map(platforms.map((p) => [p.id, p]))
    const llmConfig = await readExtractionLlmConfig()
    const executionMode = await readLlmExecutionMode()
    const batchRequested = opts.batch ?? executionMode === 'batch'
    const batchProviderBroken = batchRequested && (await isLlmBatchProviderBroken(llmConfig))
    if (batchProviderBroken) {
      console.warn(
        `[enrich] batch mode requested but ${llmConfig?.provider} is known-broken (see /settings) — falling back to sync`,
      )
    }
    const useBatch = batchRequested && supportsLlmBatch(llmConfig) && !batchProviderBroken
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
      return !prev?.detailFetchedAt || (a.sourceUpdatedIso != null && prev.sourceUpdatedIso !== a.sourceUpdatedIso)
    }
    const needsDocumentSetCheck = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      const prev = previousSnapshot[cacheKey(a.platform, a.externalId)]
      return (
        !hit ||
        (a.attachments.length > 0 && hit.documentSetHash === undefined) ||
        (a.sourceUpdatedIso != null && prev?.sourceUpdatedIso !== a.sourceUpdatedIso)
      )
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
          hit.bedrooms === undefined ||
          hit.bathrooms === undefined ||
          hit.floor === undefined ||
          hit.bathroomHasTub === undefined ||
          hit.bathroomHasShower === undefined ||
          hit.heating === undefined ||
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
    const nativePhotoUrls = (a: Auction): string[] => [
      ...a.attachments
        .filter(
          (att) =>
            att.kind === 'photo' &&
            /^https?:\/\/.*\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(att.proxyUrl),
        )
        .map((att) => att.proxyUrl),
      ...(a.photoUrls ?? []),
    ]
    const targetPhotoPipelineVersion = (a: Auction): number =>
      a.platform === 'se-kronofogden' && (a.photoUrls?.length ?? 0) > 0
        ? KRONOFOGDEN_GALLERY_PHOTO_PIPELINE_VERSION
        : PHOTO_PIPELINE_VERSION
    // A prior attempt may never have run the actual photo pipeline (the
    // `if (priorEntry)` reuse branch below only carries `priorEntry.photos`
    // forward) or may have thrown before completing. `photosCheckedAt` unset
    // means "never attempted". `photoPipelineVersion` lets one improved
    // pipeline pass revisit older confirmed-empty false negatives.
    // Bounded by MAX_PHOTO_FAILURES so a listing whose PDF/URLs genuinely
    // cannot be mined doesn't retry forever.
    // Entries that already have photos normally need no backfill, except when
    // a newer crawler version now exposes native gallery URLs: in that case we
    // run once more and merge those source photos with already-mined document
    // images.
    const needsPhotoBackfill = (a: Auction): boolean => {
      const hit = cache[cacheKey(a.platform, a.externalId)]
      const photos = hit?.photos?.length ?? 0
      const targetVersion = targetPhotoPipelineVersion(a)
      const pipelineDue =
        hit?.photosCheckedAt == null || (hit.photoPipelineVersion ?? 1) < targetVersion
      return (
        hit != null &&
        pipelineDue &&
        (photos === 0 || nativePhotoUrls(a).length > 0) &&
        (hit.photoFailures ?? 0) < MAX_PHOTO_FAILURES
      )
    }
    const eligible = result.auctions.filter(
      (a) =>
        !cache[cacheKey(a.platform, a.externalId)] ||
        needsEnrich(a) ||
        needsDocumentSetCheck(a) ||
        needsLlmRetry(a) ||
        needsLlmFieldsBackfill(a) ||
        needsPhotoBackfill(a),
    )
    const todo = interleaveByPlatform(eligible)
    const maxLlmPerRun = readMaxLlmPerRun()
    console.log(
      `[enrich] crawled ${result.auctions.length}, ${todo.length} to (re)enrich · llm=${llmConfig ? `${llmConfig.model} (maxTokens=${llmConfig.maxTokens}, batch=${useBatch})` : 'off'} maxLlmPerRun=${maxLlmPerRun}`,
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
    // LLM inputs collected only when this run explicitly opts into a provider
    // Batch API (`runEnrich({ batch: true })`). Provider selection alone never
    // flips sync extraction into async batch submission.
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
        const documentSetCheckDue = needsDocumentSetCheck(a)
        let documentSetChanged = false
        let currentDocumentSet: ArchivedDocumentSetResult | null = priorEntry?.documentSetHash
          ? {
              setHash: priorEntry.documentSetHash,
              version: priorEntry.documentSetVersion ?? 0,
              changed: false,
            }
          : null

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
            normalizeAuctionDescription(a)
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

        const documentIdentity = {
          platform: a.platform,
          country: a.country,
          region: a.region,
          externalId: a.externalId,
          caseNumber: a.caseNumber,
          authority: a.authority,
        }
        // Batch-native providers read PDF raw bytes directly only on
        // explicit batch runs. Synchronous extraction keeps its existing
        // provider-specific behavior (Gemini native docs; Claude proxy text/
        // rendered pages).
        const usingNativeDoc = useBatch
          ? supportsNativeBatchDocuments(llmConfig)
          : llmConfig?.provider === 'gemini-native'
        const preparedDocuments = extractionMissing || documentSetCheckDue
          ? await prepareLiveLlmDocuments(a.attachments, documentIdentity, at)
          : null
        if ((extractionMissing || documentSetCheckDue) && preparedDocuments?.documentSetComplete) {
          currentDocumentSet = await archiveDocumentSet(
            documentIdentity,
            preparedDocuments.documentSetItems,
            at,
          )
          documentSetChanged = hasDocumentSetChanged(priorEntry, currentDocumentSet)
        }
        if (documentSetChanged) {
          console.log(
            `[enrich] document set changed for ${a.platform}:${a.externalId} -> v${currentDocumentSet?.version ?? '?'}`,
          )
        }

        const shouldExtract = extractionMissing || documentSetChanged || documentSetCheckDue
        // Skip the rules/LLM/photo extraction pipeline when the cached entry is
        // still tied to the current document set. This path may only have been
        // here to refresh detail metadata.
        if (!shouldExtract) continue

        // Only a confirmed document-set change invalidates prior document-derived facts;
        // an unknown or unavailable archive must not wipe cached extraction fields.
        const effectivePriorEntry = documentSetChanged ? undefined : priorEntry
        const archivedAuction = await readArchivedAuction(a.platform, a.externalId)
        if (!archivedAuction && detailOk) {
          console.warn(`[enrich] archived auction missing for ${a.platform}:${a.externalId}; LLM analysis will wait for the raw archive`)
        } else if (archivedAuction && !detailOk) {
          console.warn(`[enrich] ignoring archived auction for ${a.platform}:${a.externalId}; detail fetch failed this run`)
        }
        const archivedAnalysisAuction = detailOk ? archivedAuction : null
        const canUseArchivedAuction = archivedAnalysisAuction != null
        const analysisAuction = archivedAnalysisAuction ?? a
        const archivedDocuments =
          canUseArchivedAuction && currentDocumentSet
            ? await prepareArchivedLlmDocuments(archivedAnalysisAuction, {
                nativeDocuments: usingNativeDoc,
                documentSetHash: currentDocumentSet.setHash,
                documentSetVersion: currentDocumentSet.version,
              })
            : null
        const documentArchiveRequired = currentDocumentSet != null || a.attachments.length > 0
        const archivedDocumentSetReady = !currentDocumentSet || !!archivedDocuments?.documentSetComplete
        const archivedLlmReady =
          detailOk && (!documentArchiveRequired || (canUseArchivedAuction && archivedDocumentSetReady))
        const llmBlockedByArchive =
          llmConfig != null && detailOk && documentArchiveRequired && (!canUseArchivedAuction || !archivedDocumentSetReady)
        const rules = extractByRules({ title: analysisAuction.title, description: analysisAuction.description })
        // Structured values straight from the source platform beat anything
        // parsed out of free text — they are the platform's own data, not a
        // regex guess.
        const fields = {
          propertyType: rules.propertyType,
          landAreaSqm: analysisAuction.sourceLandAreaSqm ?? rules.landAreaSqm,
          livingAreaSqm: analysisAuction.sourceLivingAreaSqm ?? rules.livingAreaSqm,
          rooms: analysisAuction.sourceRooms ?? rules.rooms,
          units: rules.units,
          securityDeposit: analysisAuction.sourceSecurityDeposit ?? rules.securityDeposit,
          biddingNotes: undefined as string | null | undefined,
          condition: effectivePriorEntry?.condition,
          features: effectivePriorEntry?.features,
          bedrooms: effectivePriorEntry?.bedrooms,
          bathrooms: effectivePriorEntry?.bathrooms,
          floor: effectivePriorEntry?.floor,
          bathroomHasTub: effectivePriorEntry?.bathroomHasTub,
          bathroomHasShower: effectivePriorEntry?.bathroomHasShower,
          heating: effectivePriorEntry?.heating,
          yearBuilt: effectivePriorEntry?.yearBuilt,
          lastRenovationYear: effectivePriorEntry?.lastRenovationYear,
          renovationNotes: effectivePriorEntry?.renovationNotes,
          insights: effectivePriorEntry?.insights,
          planningNotes: effectivePriorEntry?.planningNotes,
          documentSummary: effectivePriorEntry?.documentSummary,
          marketValueEur: effectivePriorEntry?.marketValueEur,
          marketValueText: effectivePriorEntry?.marketValueText,
        }
        const mergedConfident =
          rules.confident ||
          (fields.propertyType != null &&
            fields.propertyType !== 'sonstiges' &&
            (fields.landAreaSqm != null || fields.livingAreaSqm != null))
        let cacheable: boolean
        // Two-way photo pipeline (platform/externalId guard applies to both — the
        // API endpoint enforces the same shape, so files under an unsafe path
        // would be unreachable anyway):
        //   a) Native image URLs — from the crawler's foto attachments (AT
        //      edikte.justiz.gv.at JPGs, Biddit JPEGs) and from `photoUrls`
        //      (gallery URLs crawlers collect beyond the thumbnail). We mirror
        //      them into the local image cache so the browser fetches from us,
        //      not the upstream on every card.
        //   b) When (a) yields nothing (no native URLs, or all downloads
        //      failed), mine the candidate documents for embedded rasters. Do not
        //      trust `photoCount` as a skip signal here: some crawlers can
        //      count upstream preview images without exposing download-ready
        //      full-size image URLs.
        // Wrapped in try/catch so a disk-full or subprocess failure on one
        // listing can't reject the whole Promise.all — mirrors the enrichOne
        // pattern above.
        // Runs *before* the LLM call below (unlike the pre-C.6 shape) so a
        // freshly downloaded/extracted photo set can be offered to the LLM
        // for curation in the same call — see freshPhotoFiles/candidateImages.
        let curatedPhotos: CuratedPhoto[] | undefined
        let freshPhotoFiles: string[] | undefined
        let freshPhotoDestDir: string | null = null
        // Carried forward by default (matches effectivePriorEntry); overwritten below
        // only when the photo pipeline actually runs this iteration.
        let photosCheckedAt = effectivePriorEntry?.photosCheckedAt
        let photoFailures = effectivePriorEntry?.photoFailures ?? 0
        let photoPipelineVersion = effectivePriorEntry?.photoPipelineVersion
        // Whether the photo pipeline actually ran this iteration (success or
        // failure) — distinct from cacheable below, so a photo-only backfill
        // outcome still gets persisted even when rules are unconfident and
        // the LLM is disabled/capped/failed (see cacheable assignments below).
        let photoPipelineRan = false
        if (effectivePriorEntry && !needsPhotoBackfill(a)) {
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
          curatedPhotos = effectivePriorEntry.photos?.map(normalizePhoto)
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
          // backfill may be for missing photos or for newly-exposed native
          // gallery URLs; preserve prior document photos and append new files.
          const destDir = join(IMAGES_DIR, a.platform, a.externalId)
          photoPipelineRan = true
          // The deterministic pipeline yields bare filenames; they become
          // CuratedPhoto entries (category defaults to 'sonstiges' unless the
          // LLM call below curates them for real).
          const priorPhotos = effectivePriorEntry?.photos?.map(normalizePhoto) ?? []
          let photos = priorPhotos.map((photo) => photo.file)
          let newlyDownloadedPhotos: string[] = []
          const nativeFotoUrls = nativePhotoUrls(a)
          try {
            if (nativeFotoUrls.length > 0) {
              newlyDownloadedPhotos = await downloadNativeImages([...new Set(nativeFotoUrls)], {
                destDir,
              })
              photos = [...new Set([...photos, ...newlyDownloadedPhotos])]
            }
            if (photos.length === 0 && a.attachments.length > 0) {
              photoExtractions++
              newlyDownloadedPhotos = await extractDocumentPhotos(a.attachments, {
                destDir,
                maxPhotos: MAX_DOCUMENT_PHOTOS_PER_LISTING,
              })
              photos = newlyDownloadedPhotos
            }
            photosTotal += photos.length
            // Mirror the freshly written files into the images bucket (WP-4) so
            // /api/auction-image can fall back to Supabase once the local cache
            // is gone. Best-effort — uploadImage never throws and no-ops
            // without a configured bucket; skip re-reading the files off disk
            // entirely in that (default) case.
            if (imagesBucketConfigured()) {
              for (const name of [...new Set(newlyDownloadedPhotos)]) {
                const bytes = await readFile(join(destDir, name))
                await uploadImage(bytes, `${a.platform}/${a.externalId}/${name}`)
              }
            }
            // Completed without throwing — "checked", regardless of whether
            // any photos were actually found (a legitimately photo-less
            // listing/document stops being retried from here on).
            photosCheckedAt = at
            photoFailures = 0
            photoPipelineVersion = targetPhotoPipelineVersion(a)
          } catch (err) {
            photoFailures++
            console.warn(
              `[enrich] photo extraction failed for ${a.platform}:${a.externalId}: ${(err as Error).message}`,
            )
          }
          curatedPhotos = photos.length > 0
            ? photos.map(
                (name) => priorPhotos.find((photo) => photo.file === name) ?? normalizePhoto(name),
              )
            : undefined
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
        if (llmConfig && archivedLlmReady && llmCalls < maxLlmPerRun && platformLlmCalls < llmCapPerPlatform) {
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

          if (useBatch) {
            // Batch mode (see llm-batch.ts): collect this item's LLM
            // input for one submitLlmBatch call after the whole worker
            // pool finishes instead of a synchronous generateContent call —
            // the rate limit/cost profile that motivated this path can't
            // sustain hundreds of synchronous calls in a couple of minutes.
            batchItems.push({
              key,
              input: {
                title: analysisAuction.title,
                description: analysisAuction.description,
                ...(archivedDocuments?.input ?? {}),
                candidateImages,
              },
            })
            // Same fallback as the per-run/per-platform cap-hit branch below
            // — cache the rules-only result now so the listing shows
            // *something* immediately; llm-batch-poll.ts merges the LLM
            // contribution once the submitted job completes.
            cacheable = mergedConfident || detailOk || photoPipelineRan
          } else {
            const llm = await extractByLlm(
              {
                title: analysisAuction.title,
                description: analysisAuction.description,
                ...(archivedDocuments?.input ?? {}),
                candidateImages,
              },
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
              ...mergeLlmResult(effectivePriorEntry, { ...fields, confident: mergedConfident }, llm, at, curatedPhotos),
              // Override mergeLlmResult's priorEntry-carried defaults with this
              // iteration's actual photo-attempt outcome (explicit `undefined`
              // clears a stale value rather than leaving the carried-forward one).
              photosCheckedAt,
              photoFailures: photoFailures > 0 ? photoFailures : undefined,
              photoPipelineVersion,
              documentSetHash: currentDocumentSet?.setHash ?? null,
              documentSetVersion: currentDocumentSet?.version ?? null,
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
        } else if (llmConfig && llmBlockedByArchive) {
          const merged = {
            ...mergeLlmResult(effectivePriorEntry, { ...fields, confident: mergedConfident }, null, at, curatedPhotos),
            photosCheckedAt,
            photoFailures: photoFailures > 0 ? photoFailures : undefined,
            photoPipelineVersion,
            documentSetHash: currentDocumentSet?.setHash ?? effectivePriorEntry?.documentSetHash ?? null,
            documentSetVersion: currentDocumentSet?.version ?? effectivePriorEntry?.documentSetVersion ?? null,
          }
          cacheable = mergedConfident || detailOk || photoPipelineRan || (merged.llmFailures ?? 0) > 0
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
        const prevFailures = effectivePriorEntry?.llmFailures ?? 0
        const entry: AuctionExtraction = {
          ...fields,
          source: 'rules',
          confidence: hasType && hasArea ? 'high' : 'low',
          photos: curatedPhotos,
          photosCheckedAt,
          photoFailures: photoFailures > 0 ? photoFailures : undefined,
          photoPipelineVersion,
          documentSetHash: currentDocumentSet?.setHash ?? null,
          documentSetVersion: currentDocumentSet?.version ?? null,
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

    if (batchItems.length > 0 && llmConfig && useBatch) {
      const submission = await submitLlmBatch(batchItems, llmConfig, 'enrich')
      if (submission) {
        // Mark every submitted item's already-cached rules-only entry with
        // the job name so needsLlmRetry/needsLlmFieldsBackfill don't
        // re-submit it to a second job while this one is still in flight
        // (see AuctionExtraction.llmBatchJob / isLlmBatchPending).
        for (const item of submission.submitted) {
          const priorItemEntry = cache[item.key]
          if (!priorItemEntry) continue
          const marked = { ...priorItemEntry, llmBatchJob: item.jobName }
          cache[item.key] = marked
          dirty[item.key] = marked
        }
        console.log(`[enrich] submitted LLM batch ${submission.jobName} with ${submission.submitted.length} items`)
        if (submission.retryItems.length > 0) {
          console.warn(`[enrich] ${submission.retryItems.length} LLM batch item(s) were not submitted — will retry next run`)
        }
      } else {
        console.warn(`[enrich] LLM batch submission failed for ${batchItems.length} items — will retry next run`)
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
    normalizeAuctionDescriptions(result.auctions)
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
