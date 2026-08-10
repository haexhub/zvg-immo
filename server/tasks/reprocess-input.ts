import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import type { LlmConfig, LlmInput, PhotoCuration } from '~/server/utils/extract/llm'
import { prepareArchivedLlmDocuments } from '~/server/utils/extract/llm-documents'
import { withDerivedExtractionFields, type MergeInputFields } from '~/server/utils/extract/merge-llm-result'
import { buildReprocessFields } from '~/server/utils/extract/reprocess-fields'
import { getPool } from '~/server/utils/db'
import { hasUnparsedArtifactVersion, readArtifactProcessingState, type ArtifactProcessingState } from '~/server/utils/artifact-version-state'
import { downloadBlob, findLatestCapture } from '~/server/utils/storage-download'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { downloadImage, mimeTypeFor } from '~/server/utils/image-storage'
import { normalizePhoto } from '~/lib/photo'
import { ensureEnabledCountriesLoaded, getEnabledCountryCodes, isCountryEnabled } from '~/server/crawlers/registry'

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
  /** WP-1 provenance: who started this run. Defaults to 'cron' — the
   *  scheduled task never sets this; only the /settings-triggered manual
   *  endpoint does. */
  trigger?: 'cron' | 'manual'
  /** Bypasses only the MAX_LLM_FAILURES cooldown gate (see cooldownElapsed
   *  in reprocess-run.ts), unlike `force` which also bypasses the "does this
   *  candidate actually need an attempt" check. Lets /settings retry a
   *  country's currently locked-out auctions immediately without re-running
   *  the LLM on ones that already succeeded. */
  ignoreCooldown?: boolean
  /** Restricts eligibility to candidates already locked out
   *  (llm_failures >= MAX_LLM_FAILURES). Paired with ignoreCooldown by the
   *  /settings "Retry failed" action so it only ever touches the 'error'
   *  bucket — without this, a country's normal open/never-attempted
   *  candidates would also be picked up and burn LLM budget the action
   *  never asked to spend. */
  failedOnly?: boolean
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

/** Whether buildParts(input) would produce any non-text content part. Used
 *  to keep a photo-bearing/scanned-PDF candidate off a batch provider that
 *  can't take multimodal requests (see batchSupportsMultimodal) — cheaper
 *  than calling buildParts here just to inspect it. */
export function inputNeedsMultimodal(input: LlmInput): boolean {
  return !!(
    input.pdfPageImages?.length ||
    input.documentImages?.length ||
    input.candidateImages?.length ||
    input.pdfBytes ||
    input.pdfDocuments?.length
  )
}

export function readMaxLlmPerRun(): number {
  const raw = Number((useRuntimeConfig().extractLlm as { maxPerRun?: string })?.maxPerRun)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LLM_PER_RUN
}

export interface Candidate {
  platform: string
  externalId: string
  country: string
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

export function buildLlmRateLimitWarning(err: unknown, llmConfig: LlmConfig | null): string {
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

export async function effectiveCandidateCountries(opts: ReprocessOptions): Promise<string[]> {
  await ensureEnabledCountriesLoaded()
  if (opts.country) {
    const country = opts.country.trim().toLowerCase()
    return isCountryEnabled(country) ? [country] : []
  }
  return getEnabledCountryCodes()
}

export async function findCandidates(opts: ReprocessOptions, countries: readonly string[]): Promise<Candidate[]> {
  if (countries.length === 0) return []
  const db = getPool()
  if (!db) return []
  const conditions = ["rc.kind = 'auction'"]
  const params: unknown[] = []
  if (countries.length === 1) {
    conditions.push(`a.country = $${params.push(countries[0])}`)
  } else {
    conditions.push(`a.country = ANY($${params.push(countries)})`)
  }
  if (opts.platform) conditions.push(`rc.platform = $${params.push(opts.platform)}`)
  if (opts.externalId) conditions.push(`rc.external_id = $${params.push(opts.externalId)}`)
  if (opts.caseNumber) conditions.push(`a.case_number = $${params.push(opts.caseNumber)}`)
  const limitClause = opts.limit ? ` LIMIT $${params.push(opts.limit)}` : ''
  const { rows } = await db.query<{ platform: string; external_id: string; country: string }>(
    `SELECT DISTINCT rc.platform, rc.external_id, a.country
     FROM artifact_captures rc
     JOIN auctions a ON a.platform = rc.platform AND a.external_id = rc.external_id
     WHERE ${conditions.join(' AND ')}${limitClause}`,
    params,
  )
  return rows.map((r) => ({ platform: r.platform, externalId: r.external_id, country: r.country }))
}

/** Whether enrich.ts has archived a document set for this auction that this
 *  task hasn't parsed yet — the two hashes are written by different tasks on
 *  different schedules (see this file's header) and only diverge when
 *  documents were added/changed/removed since the last successful parse. */
export function hasNewArchivedDocuments(state: ArtifactProcessingState): boolean {
  return hasUnparsedArtifactVersion(state)
}

/** Overlays the LLM's index-based curation onto enrich.ts's default-
 *  categorized photo list, keeping each entry's `file` — the LLM never sees
 *  real filenames, only its position in the `candidateImages` that were sent
 *  (see `LlmInput.candidateImages`). An index outside `base` (stale/
 *  hallucinated) is ignored rather than throwing. */
export function applyPhotoCuration(base: CuratedPhoto[], curation: PhotoCuration[]): CuratedPhoto[] {
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
export async function buildCandidateImages(
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
      const localBytes = await readFile(join(destDir, photo.file)).catch(() => null)
      const bytes = localBytes ?? await downloadImage(`${platform}/${externalId}/${photo.file}`)
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
 * always the latest structured extraction; photo fields are read from it
 * regardless of a document-set change. Extraction-owned fields below
 * fall back to it only when the document set hasn't changed since the last
 * parse. Returns null when the auction capture can't be found or read.
 */
export async function buildReprocessInput(
  platform: string,
  externalId: string,
  priorEntry: AuctionExtraction | undefined,
  llmConfig: LlmConfig | null,
  opts: { nativeDocuments?: boolean; artifactState?: ArtifactProcessingState } = {},
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
    /** Manifest whose exact item bytes were used to build the LLM input. */
    artifactVersionId: number | null
    photoSourceIndices: number[] | undefined
    /** The archived crawl snapshot itself — the only place persistEntry can
     *  recover crawl-owned facts (address, price, photos, ...) from when
     *  there is no auction_details row yet to carry them forward from. */
    auction: Auction
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

  const artifactState = opts.artifactState ?? await readArtifactProcessingState(platform, externalId)
  const documentSetChanged = hasNewArchivedDocuments(artifactState)
  const fields = buildReprocessFields(auction, priorEntry, documentSetChanged)

  let input: LlmInput | null = null
  let documentSetComplete = true
  let artifactVersionId = artifactState.parsedArtifactVersionId
  let photoSourceIndices: number[] | undefined
  if (llmConfig) {
    // Native document understanding for batch providers reads PDF bytes
    // directly and needs neither pdftotext nor rendered page images for those
    // PDFs. DOCX/HTML/text/image attachments are still normalized by
    // prepareArchivedLlmDocuments so every archived attachment can contribute.
    const usingNativeDoc = opts.nativeDocuments ?? llmConfig.provider === 'gemini-native'
    const candidates = await buildCandidateImages(platform, externalId, priorEntry?.photos?.map(normalizePhoto))
    photoSourceIndices = candidates?.sourceIndices
    const documentParts = await prepareArchivedLlmDocuments(auction, {
      nativeDocuments: usingNativeDoc,
      artifactVersionId: artifactState.latest?.id ?? null,
    })
    documentSetComplete = documentParts.documentSetComplete
    artifactVersionId = documentParts.artifactVersionId
    input = {
      title: auction.title,
      description: auction.description,
      ...documentParts.input,
      candidateImages: candidates?.images,
    }
  }

  return { fields, input, documentSetChanged, documentSetComplete, artifactVersionId, photoSourceIndices, auction }
}

/** One auction's built reprocess input — named so it can be handed from
 *  runReprocess's batch path to reprocessAuction (see `prebuiltBase`). */
export type ReprocessInput = NonNullable<Awaited<ReturnType<typeof buildReprocessInput>>>

/** Rules-only entry for a candidate no LLM attempt was made for (LLM
 *  disabled, or — in batch mode — an attempt was only just submitted and not
 *  yet resolved). Failure counter carried forward unchanged, since no
 *  attempt happened. Crawl-owned photo fields are carried forward. */
export function buildRulesOnlyEntry(
  fields: MergeInputFields,
  priorEntry: AuctionExtraction | undefined,
  at: string,
): AuctionExtraction {
  const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
  const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
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
    llmAnalyzedAt: priorEntry?.llmAnalyzedAt,
    at,
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
