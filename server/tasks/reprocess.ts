// Extraction task — runs regex rules and (when configured) an LLM against
// already-archived captures (raw_captures/raw_document_sets), never against a
// live portal fetch. Fully decoupled from server/tasks/enrich.ts (the crawl/
// archive task): the two never call each other and don't share a schedule —
// this task finds its own work by comparing, for every archived auction,
// `archivedDocumentSetHash` (what enrich.ts last archived) against
// `documentSetHash` (what this task last actually parsed). That's also why
// an LLM outage or an exhausted token budget only ever delays this task,
// never enrich.ts — crawling/archiving doesn't depend on this running at all.
//
// A changed archived hash means the underlying documents were added,
// changed, or removed since the last successful parse — the extraction-owned
// fields (propertyType, condition, features, marketValueEur, ...) are
// rebuilt from scratch from the new documents rather than merged with stale
// facts from a withdrawn/updated one (a null-out, not a real DB delete: the
// next successful merge simply doesn't carry the old values forward).
//
// Runs on its own schedule (nuxt.config.ts's scheduledTasks) across every
// country currently enabled in the admin data-source settings. Also invokable
// manually/scoped — `runTask('reprocess', {payload})` or the Nitro task-run
// endpoint — for iterating on prompts/rules against the frozen archive, or
// spot-checking a single auction/platform/country.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { getPool } from '~/server/utils/db'
import { extractByRules } from '~/server/utils/extract/rules'
import {
  extractByLlm,
  isLlmProviderError,
  isLlmProviderUnavailable,
  isRateLimitError,
  type LlmConfig,
  type LlmInput,
  type PhotoCuration,
} from '~/server/utils/extract/llm'
import { prepareArchivedLlmDocuments } from '~/server/utils/extract/llm-documents'
import {
  isLlmBatchPending,
  isLlmBatchProviderBroken,
  submitLlmBatch,
  supportsLlmBatch,
  supportsNativeBatchDocuments,
} from '~/server/utils/extract/llm-batch'
import { readLlmExecutionMode } from '~/server/utils/app-settings'
import { MAX_LLM_FAILURES, readExtractionLlmConfigChain } from '~/server/utils/extract/llm-task-config'
import { mergeLlmResult, withDerivedExtractionFields, type MergeInputFields } from '~/server/utils/extract/merge-llm-result'
import {
  applyExtractionToAuctions,
  readExtractionCache,
  writeExtractionCache,
  type ExtractionCache,
} from '~/server/utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { downloadBlob, findLatestCapture } from '~/server/utils/storage-download'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { interleaveByPlatform } from '~/server/utils/interleave-by-platform'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { downloadImage, mimeTypeFor } from '~/server/utils/image-storage'
import { normalizePhoto } from '~/lib/photo'
import { recordTaskRunEnd, recordTaskRunProgress, recordTaskRunStart } from '~/server/utils/task-runs'
import {
  ensureEnabledCountriesLoaded,
  getEnabledCountryCodes,
  isCountryEnabled,
} from '~/server/crawlers/registry'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')
const DEFAULT_MAX_LLM_PER_RUN = 300
// Cap on candidate photos sent to the LLM for curation per call — a Gutachten
// with dozens of embedded rasters would otherwise blow the token budget.
const MAX_CANDIDATE_PHOTOS = 8

export interface ReprocessOptions {
  /** ISO-3166-1 alpha-2, lowercase. Omit to scan every enabled country. */
  country?: string
  platform?: string
  externalId?: string
  caseNumber?: string
  /** Reprocess even entries that already look complete (high confidence,
   *  condition/features already checked) — for iterating on prompts against
   *  auctions already extracted. Requires platform/externalId/caseNumber or
   *  limit so an unbounded forced re-run of an entire country can't happen
   *  by accident. */
  force?: boolean
  /** Cap the number of candidates considered (SQL LIMIT), for a bounded spot
   *  check before committing to a full run — e.g. verifying a new
   *  provider/model config against a handful of auctions first. */
  limit?: number
  /** Submit eligible candidates to the configured provider's Batch API
   *  instead of extracting each one synchronously. Default false (unchanged
   *  synchronous behavior) — this is also a manually triggered debug/backfill
   *  tool where an immediate result is usually wanted; opt in only for a
   *  deliberate full batch run. Only takes effect when llm-batch.ts knows how
   *  to batch the configured provider. */
  batch?: boolean
}

export interface ReprocessResult {
  candidates: number
  processed: number
  skipped: number
  llmCalls: number
  /** Count of LLM calls this run where the provider request itself failed
   *  (network/HTTP error, e.g. an unauthenticated-caller 403) — distinct from
   *  a call that succeeded but returned an empty/unparseable result. See
   *  ExtractionProvider.extract()'s onRequestError in llm.ts. */
  llmErrors: number
  durationMs: number
  warning?: string
  /** Message from the most recent llmErrors failure this run, so a run that
   *  "completed" while every LLM call errored is visible instead of looking
   *  identical to a healthy rules-only run (observed in prod: 69 processed /
   *  69 llmCalls with zero visible errors while all 69 were failing 403s). */
  lastLlmError?: string
}

function readMaxLlmPerRun(): number {
  const raw = Number((useRuntimeConfig().extractLlm as { maxPerRun?: string })?.maxPerRun)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LLM_PER_RUN
}

interface Candidate {
  platform: string
  externalId: string
}

interface QuotaViolation {
  quotaMetric?: unknown
  quotaId?: unknown
  quotaDimensions?: unknown
  quotaValue?: unknown
}

function firstQuotaViolation(err: unknown): QuotaViolation | null {
  const details = (err as { data?: { error?: { details?: unknown[] } } })?.data?.error?.details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    const violations = (detail as { violations?: unknown[] })?.violations
    if (!Array.isArray(violations)) continue
    const violation = violations.find((entry) => entry && typeof entry === 'object')
    if (violation) return violation as QuotaViolation
  }
  return null
}

function retryDelay(err: unknown): string | null {
  const details = (err as { data?: { error?: { details?: unknown[] } } })?.data?.error?.details
  if (!Array.isArray(details)) return null
  for (const detail of details) {
    const delay = (detail as { retryDelay?: unknown })?.retryDelay
    if (typeof delay === 'string' && delay) return delay
  }
  return null
}

function buildLlmRateLimitWarning(err: unknown, llmConfig: LlmConfig | null): string {
  const provider = llmConfig?.provider ?? 'openai-compatible'
  const configuredModel = llmConfig?.model ?? 'unknown-model'
  const violation = firstQuotaViolation(err)
  const quotaDimensions = violation?.quotaDimensions as Record<string, unknown> | undefined
  const model = typeof quotaDimensions?.model === 'string' && quotaDimensions.model ? quotaDimensions.model : configuredModel
  const parts = [`LLM-Rate-Limit: ${provider}/${model}`]
  if (typeof violation?.quotaId === 'string' && violation.quotaId) parts.push(`Quota ${violation.quotaId}`)
  if (typeof violation?.quotaValue === 'string' && violation.quotaValue) parts.push(`Limit ${violation.quotaValue}`)
  const delay = retryDelay(err)
  if (delay) parts.push(`Retry nach ${delay}`)
  return `${parts.join('; ')}.`
}

async function effectiveCandidateCountries(opts: ReprocessOptions): Promise<string[]> {
  await ensureEnabledCountriesLoaded()
  if (opts.country) {
    const country = opts.country.trim().toLowerCase()
    return isCountryEnabled(country) ? [country] : []
  }
  return getEnabledCountryCodes()
}

async function findCandidates(opts: ReprocessOptions, countries: readonly string[]): Promise<Candidate[]> {
  if (countries.length === 0) return []
  const db = getPool()
  if (!db) return []
  const conditions = ["kind = 'auction'"]
  const params: unknown[] = []
  if (countries.length === 1) {
    conditions.push(`country = $${params.push(countries[0])}`)
  } else {
    conditions.push(`country = ANY($${params.push(countries)})`)
  }
  if (opts.platform) conditions.push(`platform = $${params.push(opts.platform)}`)
  if (opts.externalId) conditions.push(`external_id = $${params.push(opts.externalId)}`)
  if (opts.caseNumber) conditions.push(`case_number = $${params.push(opts.caseNumber)}`)
  const limitClause = opts.limit ? ` LIMIT $${params.push(opts.limit)}` : ''
  const { rows } = await db.query<{ platform: string; external_id: string }>(
    `SELECT DISTINCT platform, external_id FROM raw_captures WHERE ${conditions.join(' AND ')}${limitClause}`,
    params,
  )
  return rows.map((r) => ({ platform: r.platform, externalId: r.external_id }))
}

/** Whether enrich.ts has archived a document set for this auction that this
 *  task hasn't parsed yet — the two hashes are written by different tasks on
 *  different schedules (see this file's header) and only diverge when
 *  documents were added/changed/removed since the last successful parse. */
function hasNewArchivedDocuments(priorEntry: AuctionExtraction | undefined): boolean {
  return (
    !!priorEntry?.archivedDocumentSetHash &&
    priorEntry.archivedDocumentSetHash !== priorEntry.documentSetHash
  )
}

/** Overlays the LLM's index-based curation onto enrich.ts's default-
 *  categorized photo list, keeping each entry's `file` — the LLM never sees
 *  real filenames, only its position in the `candidateImages` that were sent
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

/** `sourceIndices[i]` is the position in the original (uncapped) `photos`
 *  array that `images[i]` came from — a per-photo read failure drops that
 *  photo rather than the whole set, which shifts later images down, so
 *  callers must remap the LLM's `photoIndex` (relative to `images`) through
 *  this array before applying curation back onto the original photo list. */
async function buildCandidateImages(
  platform: string,
  externalId: string,
  photos: CuratedPhoto[] | undefined,
): Promise<
  { images: { label: string; mimeType: string; data: string }[]; sourceIndices: number[] } | undefined
> {
  if (!photos?.length || !isSafePathSegment(platform) || !isSafePathSegment(externalId)) return undefined
  const destDir = join(IMAGES_DIR, platform, externalId)
  const capped = photos.slice(0, MAX_CANDIDATE_PHOTOS)
  const read = await Promise.all(
    capped.map(async (photo, sourceIndex) => {
      // Local cache first, then the images bucket: an ended auction's photos may
      // have been offloaded (server/tasks/offload-images.ts), and falling
      // through to text-only extraction would silently produce a worse result.
      let bytes = await readFile(join(destDir, photo.file)).catch(() => null)
      if (!bytes) bytes = await downloadImage(`${platform}/${externalId}/${photo.file}`)
      if (!bytes) {
        console.warn(`[reprocess] candidate image unavailable for ${platform}:${externalId}/${photo.file}`)
        return null
      }
      return {
        sourceIndex,
        label: photo.file,
        mimeType: mimeTypeFor(photo.file),
        data: bytes.toString('base64'),
      }
    }),
  )
  const kept = read.filter((img): img is NonNullable<typeof img> => img != null)
  if (!kept.length) return undefined
  return {
    images: kept.map(({ label, mimeType, data }) => ({ label, mimeType, data })),
    sourceIndices: kept.map((img) => img.sourceIndex),
  }
}

/**
 * Re-derives one auction's rules/structured fields and (when an LLM is
 * configured) its LLM request input from its archived captures — the
 * fetch+rules step shared by both the synchronous path (reprocessAuction)
 * and the explicit Batch opt-in path (runReprocess) below. `priorEntry` is
 * always the *raw* cache entry (photos/archivedDocumentSetHash are read from
 * it regardless of a document-set change); the extraction-owned fields below
 * fall back to it only when the document set hasn't changed since the last
 * parse. Returns null when the auction capture can't be found or read.
 */
async function buildReprocessInput(
  platform: string,
  externalId: string,
  priorEntry: AuctionExtraction | undefined,
  llmConfig: LlmConfig | null,
  opts: { nativeDocuments?: boolean } = {},
): Promise<
  {
    fields: MergeInputFields
    input: LlmInput | null
    documentSetChanged: boolean
    /** Whether the archived document set this LLM input was built from was
     *  read in full — false when a document blob couldn't be downloaded, in
     *  which case the parse must not be stamped as caught up (see
     *  reprocessAuction). Always true when no LLM was configured. */
    documentSetComplete: boolean
    photoSourceIndices: number[] | undefined
  } | null
> {
  const auctionCapture = await findLatestCapture('auction', platform, externalId)
  if (!auctionCapture) return null
  const auctionBytes = await downloadBlob(auctionCapture.contentHash)
  if (!auctionBytes) return null

  let auction: Auction
  try {
    auction = JSON.parse(auctionBytes.toString('utf8')) as Auction
  } catch {
    return null
  }

  const documentSetChanged = hasNewArchivedDocuments(priorEntry)
  const effectivePriorEntry = documentSetChanged ? undefined : priorEntry

  const rules = extractByRules({ title: auction.title, description: auction.description })
  const propertyType = rules.propertyType
  const landAreaSqm = auction.sourceLandAreaSqm ?? rules.landAreaSqm
  const livingAreaSqm = auction.sourceLivingAreaSqm ?? rules.livingAreaSqm
  const fields: MergeInputFields = {
    propertyType,
    landAreaSqm,
    livingAreaSqm,
    rooms: auction.sourceRooms ?? rules.rooms,
    units: rules.units,
    securityDeposit: auction.sourceSecurityDeposit ?? rules.securityDeposit,
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
    confident:
      rules.confident || (propertyType != null && propertyType !== 'sonstiges' && (landAreaSqm != null || livingAreaSqm != null)),
  }

  let input: LlmInput | null = null
  let documentSetComplete = true
  let photoSourceIndices: number[] | undefined
  if (llmConfig) {
    // Native document understanding for batch providers reads PDF bytes
    // directly and needs neither pdftotext nor rendered page images for those
    // PDFs. DOCX/HTML/text/image attachments are still normalized by
    // prepareArchivedLlmDocuments so every archived attachment can contribute.
    const usingNativeDoc = opts.nativeDocuments ?? llmConfig.provider === 'gemini-native'
    const candidates = await buildCandidateImages(platform, externalId, priorEntry?.photos?.map(normalizePhoto))
    photoSourceIndices = candidates?.sourceIndices
    // Always read the *latest archived* set (enrich.ts's bookkeeping), not
    // this task's own documentSetHash — that would re-read the version we
    // already parsed instead of picking up a just-archived change.
    const documentParts = await prepareArchivedLlmDocuments(auction, {
      nativeDocuments: usingNativeDoc,
      documentSetHash: priorEntry?.archivedDocumentSetHash,
      documentSetVersion: priorEntry?.archivedDocumentSetVersion,
    })
    documentSetComplete = documentParts.documentSetComplete
    input = {
      title: auction.title,
      description: auction.description,
      ...documentParts.input,
      candidateImages: candidates?.images,
    }
  }

  return { fields, input, documentSetChanged, documentSetComplete, photoSourceIndices }
}

/** Rules-only entry for a candidate no LLM attempt was made for (LLM
 *  disabled, or — in batch mode — an attempt was only just submitted and not
 *  yet resolved). Failure counter carried forward unchanged, since no
 *  attempt happened. Crawl-owned fields (photos/archivedDocumentSetHash/...)
 *  are always carried forward from the *raw* priorEntry regardless of a
 *  document-set change — this task never touches them except passing them
 *  through untouched. */
function buildRulesOnlyEntry(
  fields: MergeInputFields,
  priorEntry: AuctionExtraction | undefined,
  at: string,
): AuctionExtraction {
  const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
  const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
  const prevFailures = priorEntry?.llmFailures ?? 0
  return withDerivedExtractionFields({
    propertyType: fields.propertyType,
    landAreaSqm: fields.landAreaSqm,
    livingAreaSqm: fields.livingAreaSqm,
    rooms: fields.rooms,
    bedrooms: fields.bedrooms,
    bathrooms: fields.bathrooms,
    floor: fields.floor,
    bathroomHasTub: fields.bathroomHasTub,
    bathroomHasShower: fields.bathroomHasShower,
    heating: fields.heating,
    units: fields.units,
    securityDeposit: fields.securityDeposit,
    biddingNotes: priorEntry?.biddingNotes,
    condition: fields.condition,
    features: fields.features,
    yearBuilt: fields.yearBuilt,
    lastRenovationYear: fields.lastRenovationYear,
    renovationNotes: fields.renovationNotes,
    insights: fields.insights,
    planningNotes: fields.planningNotes,
    documentSummary: fields.documentSummary,
    marketValueEur: fields.marketValueEur,
    marketValueText: fields.marketValueText,
    source: 'rules',
    confidence: hasType && hasArea ? 'high' : 'low',
    photos: priorEntry?.photos,
    photosCheckedAt: priorEntry?.photosCheckedAt,
    photoPipelineVersion: priorEntry?.photoPipelineVersion,
    documentSetHash: priorEntry?.documentSetHash ?? null,
    documentSetVersion: priorEntry?.documentSetVersion ?? null,
    archivedDocumentSetHash: priorEntry?.archivedDocumentSetHash ?? null,
    archivedDocumentSetVersion: priorEntry?.archivedDocumentSetVersion ?? null,
    at,
    ...(prevFailures > 0 ? { llmFailures: prevFailures } : {}),
    ...(priorEntry?.photoFailures ? { photoFailures: priorEntry.photoFailures } : {}),
  })
}

/**
 * Re-derives one auction's AuctionExtraction from its archived 'auction'
 * capture (title/description/attachments — the same shape enrichOne would
 * have produced) and, if needed, its archived 'document' capture (the best
 * appraisal PDF's raw bytes). Mirrors enrich.ts's former rules → LLM(text) →
 * LLM(vision) cascade, just against archived bytes instead of a live fetch,
 * plus photo curation (enrich.ts downloads/mines the files; this call only
 * refines their category/caption via the LLM's photoCuration). Returns null
 * when the auction/PDF capture can't be found or read.
 */
export async function reprocessAuction(
  platform: string,
  externalId: string,
  priorEntry: AuctionExtraction | undefined,
  llmConfig: LlmConfig | null,
  at: string,
  opts: {
    onLlmAttempt?: () => void
    onLlmError?: (err: unknown) => void
    /** Tried in order after `llmConfig`, only when the current model is
     *  rate-limited/over quota or otherwise unavailable (see
     *  isLlmProviderUnavailable) — not on a caller-side error. */
    fallbackConfigs?: LlmConfig[]
  } = {},
): Promise<{ entry: AuctionExtraction; llmCalled: boolean } | null> {
  let base = await buildReprocessInput(platform, externalId, priorEntry, llmConfig)
  if (!base) return null

  if (!llmConfig) {
    return { entry: buildRulesOnlyEntry(base.fields, priorEntry, at), llmCalled: false }
  }

  const configs = [llmConfig, ...(opts.fallbackConfigs ?? [])]
  let llm: Awaited<ReturnType<typeof extractByLlm>> = null
  for (const [index, config] of configs.entries()) {
    if (index > 0) {
      // Rebuild rather than reuse base.input: nativeDocuments (gemini-native's
      // raw-PDF path vs. every other provider's rasterized images) depends on
      // which provider is actually being asked, and the fallback's provider
      // can differ from the one buildReprocessInput was first built for.
      const rebuilt = await buildReprocessInput(platform, externalId, priorEntry, config)
      if (!rebuilt) break
      base = rebuilt
    }
    try {
      llm = await extractByLlm(base.input!, config, {
        onProviderAttempt: opts.onLlmAttempt,
        onProviderError: opts.onLlmError,
      })
      break
    } catch (err) {
      const isLast = index === configs.length - 1
      if (isLast || !isLlmProviderUnavailable(err)) throw err
      console.warn(
        `[reprocess] ${config.provider ?? 'openai-compatible'}/${config.model} unavailable for ${platform}:${externalId}, trying next configured model: ${(err as Error).message}`,
      )
    }
  }
  let curatedPhotos = priorEntry?.photos?.map(normalizePhoto)
  if (llm && curatedPhotos && base.input?.candidateImages?.length && llm.photoCuration.length) {
    // llm.photoCuration's photoIndex is relative to the candidateImages that
    // were actually sent, which buildCandidateImages may have shrunk (dropped
    // unreadable photos) — remap through photoSourceIndices back to curatedPhotos'
    // original positions before applying.
    const sourceIndices = base.photoSourceIndices
    const curation = sourceIndices
      ? llm.photoCuration
          .map((c) => (sourceIndices[c.photoIndex] != null ? { ...c, photoIndex: sourceIndices[c.photoIndex] } : null))
          .filter((c): c is PhotoCuration => c != null)
      : llm.photoCuration
    curatedPhotos = applyPhotoCuration(curatedPhotos, curation)
  }
  const effectivePriorEntry = base.documentSetChanged ? undefined : priorEntry
  // Only mark "parsed up to the currently archived version" when the LLM
  // call actually succeeded and the archived document set was read in full —
  // otherwise carry the prior documentSetHash forward so this entry stays
  // due for reprocessing next run (see buildReprocessInput's documentSetComplete).
  const parsedCurrentSet = llm != null && base.documentSetComplete
  const entry: AuctionExtraction = {
    ...mergeLlmResult(effectivePriorEntry, base.fields, llm, at, curatedPhotos),
    documentSetHash: parsedCurrentSet ? (priorEntry?.archivedDocumentSetHash ?? null) : (priorEntry?.documentSetHash ?? null),
    documentSetVersion: parsedCurrentSet
      ? (priorEntry?.archivedDocumentSetVersion ?? null)
      : (priorEntry?.documentSetVersion ?? null),
    // Crawl-owned fields — pass through untouched, this task never sets them.
    archivedDocumentSetHash: priorEntry?.archivedDocumentSetHash ?? null,
    archivedDocumentSetVersion: priorEntry?.archivedDocumentSetVersion ?? null,
  }
  return { entry, llmCalled: true }
}

export default defineTask({
  meta: {
    name: 'reprocess',
    description:
      'Run rules/LLM extraction (incl. vision) against archived raw_captures — no live portal fetch. Scheduled across all countries; also invokable manually/scoped.',
  },
  async run(event) {
    return await runExclusiveTask('reprocess', async (signal) => {
      await recordTaskRunStart('reprocess')
      try {
        const result = await runReprocess((event?.payload ?? {}) as ReprocessOptions, signal)
        const { warning, lastLlmError, ...summary } = result
        await recordTaskRunEnd('reprocess', { result: summary, warning, llmError: lastLlmError })
        return { result }
      } catch (err) {
        await recordTaskRunEnd('reprocess', { error: (err as Error).message })
        throw err
      }
    })
  },
})

export async function runReprocess(opts: ReprocessOptions = {}, signal?: AbortSignal): Promise<ReprocessResult> {
  const startedAt = Date.now()
  if (opts.force && !opts.country && !opts.platform && !opts.externalId && !opts.caseNumber && !opts.limit) {
    throw new Error(
      '[reprocess] force requires country/platform/externalId/caseNumber or limit — an unbounded forced re-run would re-spend the LLM budget on every already-extracted auction',
    )
  }

  const candidateCountries = await effectiveCandidateCountries(opts)
  const rawCandidates = await findCandidates(opts, candidateCountries)
  const candidates = interleaveByPlatform(rawCandidates)
  if (candidates.length === 0) {
    const durationMs = Date.now() - startedAt
    console.log(`[reprocess] candidates=0 processed=0 skipped=0 llmCalls=0 in ${(durationMs / 1000).toFixed(0)}s`)
    return { candidates: 0, processed: 0, skipped: 0, llmCalls: 0, llmErrors: 0, durationMs }
  }
  const cache = await readExtractionCache()
  // Batch submission (below) is committed to one model per job, so only the
  // sync path (reprocessAuction, further down) gets the rest of the chain as
  // automatic fallback — llmConfig itself stays the primary everywhere else
  // (logging, batch capability checks) exactly as before.
  const llmConfigs = await readExtractionLlmConfigChain()
  const llmConfig = llmConfigs[0] ?? null
  const executionMode = await readLlmExecutionMode()
  const maxLlmPerRun = readMaxLlmPerRun()
  const at = new Date().toISOString()
  // Any provider without a Batch API integration falls back to the
  // synchronous path even if `batch: true` was requested.
  const batchRequested = opts.batch ?? executionMode === 'batch'
  // opts.batch === true is always an explicit choice (the /settings "Submit
  // via Batch API" checkbox) — unlike the executionMode-derived default,
  // that's the deliberate recovery probe the PR added, so it must reach the
  // provider even when marked known-broken, or the capability could never
  // clear back to ok:true once set.
  const isExplicitBatchProbe = opts.batch === true
  const batchProviderBroken = batchRequested && !isExplicitBatchProbe && (await isLlmBatchProviderBroken(llmConfig))
  if (batchProviderBroken) {
    console.warn(
      `[reprocess] batch mode requested but ${llmConfig?.provider} is known-broken (see /settings) — falling back to sync`,
    )
  }
  const useBatch = batchRequested && supportsLlmBatch(llmConfig) && !batchProviderBroken
  if (llmConfig) {
    const chainLabel = llmConfigs.map((c) => `${c.provider ?? 'openai-compatible'}/${c.model}`).join(' → ')
    console.log(
      `[reprocess] llm ${chainLabel} mode=${useBatch ? 'batch' : 'sync'} maxPerRun=${maxLlmPerRun}`,
    )
  } else {
    console.log('[reprocess] llm disabled — rules-only')
  }

  // maxLlmPerRun is shared across all platforms; a per-platform cap keeps one
  // huge platform's backlog from burning through the whole budget before
  // smaller platforms' listings are ever reached (same rationale enrich.ts
  // used to apply — see interleave-by-platform.ts).
  const llmPlatformCount = new Set(candidates.map((c) => c.platform)).size || 1
  const llmCapPerPlatform = Math.max(1, Math.ceil(maxLlmPerRun / llmPlatformCount))
  const llmCallsByPlatform = new Map<string, number>()

  let processed = 0
  let skipped = 0
  let llmCalls = 0
  let llmErrors = 0
  let lastLlmError: string | undefined
  let warning: string | undefined
  const dirty: ExtractionCache = {}
  const batchItems: { key: string; input: LlmInput }[] = []

  async function persistEntry(key: string, entry: AuctionExtraction): Promise<boolean> {
    const ok = await writeExtractionCache({ [key]: entry })
    if (ok) {
      delete dirty[key]
    } else {
      dirty[key] = entry
    }
    return ok
  }

  async function syncSnapshotEntry(key: string, entry: AuctionExtraction): Promise<void> {
    const snapshot = await readAuctionSnapshot()
    const snapshotEntry = snapshot[key]
    if (!snapshotEntry) return
    const updated: Auction = { ...snapshotEntry }
    applyExtractionToAuctions([updated], { [key]: entry })
    await writeAuctionSnapshot([updated])
  }

  for (const { platform, externalId } of candidates) {
    throwIfTaskAborted(signal)
    try {
      const key = cacheKey(platform, externalId)
      const priorEntry = cache[key]
      const hasMissingLlmOnlyField = priorEntry
        ? priorEntry.condition === undefined ||
          priorEntry.features === undefined ||
          priorEntry.bedrooms === undefined ||
          priorEntry.bathrooms === undefined ||
          priorEntry.floor === undefined ||
          priorEntry.bathroomHasTub === undefined ||
          priorEntry.bathroomHasShower === undefined ||
          priorEntry.heating === undefined ||
          priorEntry.yearBuilt === undefined ||
          priorEntry.lastRenovationYear === undefined ||
          priorEntry.renovationNotes === undefined ||
          priorEntry.insights === undefined ||
          priorEntry.planningNotes === undefined ||
          priorEntry.documentSummary === undefined ||
          priorEntry.marketValueEur === undefined
        : false
      const eligible =
        opts.force ||
        ((!priorEntry ||
          (priorEntry.source === 'rules' && priorEntry.confidence === 'low') ||
          (llmConfig != null && hasMissingLlmOnlyField) ||
          hasNewArchivedDocuments(priorEntry)) &&
          (priorEntry?.llmFailures ?? 0) < MAX_LLM_FAILURES &&
          !isLlmBatchPending(priorEntry))
      if (!eligible) {
        skipped++
        continue
      }

      const platformLlmCalls = llmCallsByPlatform.get(platform) ?? 0
      const llmReady = !!llmConfig && llmCalls < maxLlmPerRun && platformLlmCalls < llmCapPerPlatform
      if (opts.force && llmConfig && !llmReady) {
        skipped++
        continue
      }
      const useLlm = llmReady ? llmConfig : null

      if (useBatch && llmReady) {
        const base = await buildReprocessInput(platform, externalId, priorEntry, llmConfig, {
          nativeDocuments: supportsNativeBatchDocuments(llmConfig),
        })
        if (!base || !base.input) {
          skipped++
          continue
        }
        llmCalls++
        llmCallsByPlatform.set(platform, platformLlmCalls + 1)
        batchItems.push({ key, input: base.input })
        const entry = {
          ...buildRulesOnlyEntry(base.fields, priorEntry, at),
          documentSetHash: priorEntry?.archivedDocumentSetHash ?? null,
          documentSetVersion: priorEntry?.archivedDocumentSetVersion ?? null,
        }
        cache[key] = entry
        dirty[key] = entry
        processed++

        const snapshot = await readAuctionSnapshot()
        const snapshotEntry = snapshot[key]
        if (snapshotEntry) {
          const updated: Auction = { ...snapshotEntry }
          applyExtractionToAuctions([updated], { [key]: entry })
          await writeAuctionSnapshot([updated])
        }
        continue
      }

      let syncLlmAttempted = false
      let platformLlmCallsSoFar = platformLlmCalls
      const result = await reprocessAuction(platform, externalId, priorEntry, useLlm, at, {
        fallbackConfigs: useLlm ? llmConfigs.slice(1) : undefined,
        onLlmAttempt: () => {
          syncLlmAttempted = true
          llmCalls++
          platformLlmCallsSoFar++
          llmCallsByPlatform.set(platform, platformLlmCallsSoFar)
        },
        onLlmError: (err) => {
          llmErrors++
          const message = err instanceof Error ? err.message : String(err)
          lastLlmError = `${platform}:${externalId}: ${message}`
        },
      })
      if (!result) {
        skipped++
        continue
      }
      if (result.llmCalled && !syncLlmAttempted) {
        llmCalls++
        llmCallsByPlatform.set(platform, platformLlmCallsSoFar + 1)
      }

      cache[key] = result.entry
      dirty[key] = result.entry
      processed++

      // Persist each successful sync result immediately. Otherwise a long
      // manual run can show LLM data from the in-process cache, then lose all
      // unflushed progress when podman auto-update replaces the container.
      if (await persistEntry(key, result.entry)) {
        await syncSnapshotEntry(key, result.entry)
      }
    } catch (err) {
      // Also where a rate limit/quota error (see llm.ts's isRateLimitError())
      // lands: reprocessAuction/extractByLlm deliberately let it propagate
      // here instead of resolving to null, so `cache[key]` is left untouched
      // — a capacity outage must never count toward llmFailures/
      // MAX_LLM_FAILURES, or it would permanently downgrade the auction to
      // rules-only once the limit is hit, long after the outage clears.
      console.warn(`[reprocess] failed for ${platform}:${externalId}: ${(err as Error).message}`)
      skipped++
      if (isRateLimitError(err)) {
        warning = buildLlmRateLimitWarning(err, llmConfig)
        console.warn('[reprocess] LLM provider rate-limited — stopping this run early')
        break
      }
      if (isLlmProviderError(err)) {
        warning = `LLM-Providerfehler: ${err.message}`
        console.warn('[reprocess] LLM provider unavailable — stopping this run early')
        break
      }
    } finally {
      void recordTaskRunProgress(
        'reprocess',
        { candidatesTotal: candidates.length, processed, skipped, llmCalls, llmErrors },
        { lastLlmError },
      )
    }
  }

  if (batchItems.length > 0 && llmConfig) {
    const submission = await submitLlmBatch(batchItems, llmConfig, 'reprocess')
    if (submission) {
      // Same rationale enrich.ts used to apply: mark every submitted item so
      // a second runReprocess({ batch: true }) call doesn't re-submit it to a
      // new job while this one is still in flight (job submission isn't
      // idempotent).
      for (const item of submission.submitted) {
        const priorItemEntry = cache[item.key]
        if (!priorItemEntry) continue
        const marked = { ...priorItemEntry, llmBatchJob: item.jobName }
        cache[item.key] = marked
        dirty[item.key] = marked
      }
      console.log(`[reprocess] submitted LLM batch ${submission.jobName} with ${submission.submitted.length} items`)
      if (submission.retryItems.length > 0) {
        console.warn(`[reprocess] ${submission.retryItems.length} LLM batch item(s) were not submitted`)
      }
    } else {
      console.warn(`[reprocess] LLM batch submission failed for ${batchItems.length} items`)
    }
  }

  if (Object.keys(dirty).length > 0) await writeExtractionCache(dirty)

  const durationMs = Date.now() - startedAt
  console.log(
    `[reprocess] candidates=${candidates.length} processed=${processed} skipped=${skipped} llmCalls=${llmCalls} llmErrors=${llmErrors} in ${(durationMs / 1000).toFixed(0)}s`,
  )
  return {
    candidates: candidates.length,
    processed,
    skipped,
    llmCalls,
    llmErrors,
    durationMs,
    ...(warning ? { warning } : {}),
    ...(lastLlmError ? { lastLlmError } : {}),
  }
}
