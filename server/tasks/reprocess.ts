// WP-6 (docs/plans/2026-07-22-supabase-full-migration-de.md, decision E2):
// re-runs rules/LLM extraction against already-archived captures instead of
// live-fetching from the upstream portals. Lets the extraction prompts/rules
// be iterated on (new fields, better prompts) against the frozen archive
// without hammering the portals — the coupled crawl+archive+parse path in
// enrich.ts stays the way first-time listings get discovered and archived.
//
// No cron entry in nuxt.config.ts's scheduledTasks — this is a manually
// triggered lever (`runTask('reprocess', { payload })` or Nitro's task-run
// endpoint), not a standing background job.

import type { Auction, AuctionExtraction, CuratedPhoto } from '~/types/auction'
import { getPool } from '~/server/utils/db'
import { extractByRules } from '~/server/utils/extract/rules'
import { extractByLlm, resolveLlmConfig, type LlmConfig, type LlmInput } from '~/server/utils/extract/llm'
import { prepareArchivedLlmDocuments } from '~/server/utils/extract/llm-documents'
import {
  isLlmBatchPending,
  submitLlmBatch,
  supportsLlmBatch,
  supportsNativeBatchDocuments,
} from '~/server/utils/extract/llm-batch'
import {
  DEFAULT_LLM_MAX_TOKENS,
  getLlmMaxTokens,
  getLlmProviderOverride,
  readLlmExecutionMode,
} from '~/server/utils/app-settings'
import { mergeLlmResult, type MergeInputFields } from '~/server/utils/extract/merge-llm-result'
import {
  applyExtractionToAuctions,
  readExtractionCache,
  writeExtractionCache,
  type ExtractionCache,
} from '~/server/utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { downloadBlob, findLatestCapture } from '~/server/utils/storage-download'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { normalizePhoto } from '~/lib/photo'

const DEFAULT_COUNTRY = 'de'
const DEFAULT_MAX_LLM_PER_RUN = 300
// Same bound as server/tasks/enrich.ts: stop retrying an auction's LLM call
// after this many consecutive failures.
const MAX_LLM_FAILURES = 3

export interface ReprocessOptions {
  /** ISO-3166-1 alpha-2, lowercase. Defaults to 'de' (this WP's scope). */
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
   *  check before committing to a full country run — e.g. verifying a new
   *  provider/model config against a handful of auctions first. */
  limit?: number
  /** Submit eligible candidates to the configured provider's Batch API
   *  instead of extracting each one synchronously. Default false (unchanged
   *  synchronous behavior) — this is a manually triggered debug/backfill
   *  tool where an immediate result is usually wanted; opt in only for a
   *  deliberate full-country batch run. Only takes effect when llm-batch.ts
   *  knows how to batch the configured provider. */
  batch?: boolean
}

export interface ReprocessResult {
  candidates: number
  processed: number
  skipped: number
  llmCalls: number
}

async function readLlmConfig(): Promise<LlmConfig | null> {
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

interface Candidate {
  platform: string
  externalId: string
}

async function findCandidates(opts: ReprocessOptions): Promise<Candidate[]> {
  const db = getPool()
  if (!db) return []
  const conditions = ["kind = 'auction'"]
  const params: unknown[] = []
  conditions.push(`country = $${params.push(opts.country ?? DEFAULT_COUNTRY)}`)
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

/**
 * Re-derives one auction's rules/structured fields and (when an LLM is
 * configured) its LLM request input from its archived captures — the
 * fetch+rules step shared by both the synchronous path (reprocessAuction)
 * and explicit Batch opt-in path (runReprocess) below. Returns null when
 * the auction capture can't be found or read.
 */
async function buildReprocessInput(
  platform: string,
  externalId: string,
  priorEntry: AuctionExtraction | undefined,
  llmConfig: LlmConfig | null,
  opts: { nativeDocuments?: boolean } = {},
): Promise<{ fields: MergeInputFields; input: LlmInput | null; photos: CuratedPhoto[] | undefined } | null> {
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
    condition: priorEntry?.condition,
    features: priorEntry?.features,
    bedrooms: priorEntry?.bedrooms,
    bathrooms: priorEntry?.bathrooms,
    floor: priorEntry?.floor,
    bathroomHasTub: priorEntry?.bathroomHasTub,
    bathroomHasShower: priorEntry?.bathroomHasShower,
    heating: priorEntry?.heating,
    yearBuilt: priorEntry?.yearBuilt,
    lastRenovationYear: priorEntry?.lastRenovationYear,
    renovationNotes: priorEntry?.renovationNotes,
    insights: priorEntry?.insights,
    planningNotes: priorEntry?.planningNotes,
    documentSummary: priorEntry?.documentSummary,
    marketValueEur: priorEntry?.marketValueEur,
    marketValueText: priorEntry?.marketValueText,
    confident:
      rules.confident || (propertyType != null && propertyType !== 'sonstiges' && (landAreaSqm != null || livingAreaSqm != null)),
  }

  let input: LlmInput | null = null
  if (llmConfig) {
    // Native document understanding for batch providers reads PDF bytes
    // directly and needs neither pdftotext nor rendered page images for those
    // PDFs. DOCX/HTML/text/image attachments are still normalized by
    // prepareArchivedLlmDocuments so every archived attachment can contribute.
    const usingNativeDoc = opts.nativeDocuments ?? llmConfig.provider === 'gemini-native'
    const documentParts = await prepareArchivedLlmDocuments(auction, { nativeDocuments: usingNativeDoc })
    input = {
      title: auction.title,
      description: auction.description,
      ...documentParts.input,
    }
  }

  return { fields, input, photos: priorEntry?.photos?.map(normalizePhoto) }
}

/** Rules-only entry for a candidate no LLM attempt was made for (LLM
 *  disabled, or — in batch mode — an attempt was only just submitted and not
 *  yet resolved). Failure counter carried forward unchanged, since no
 *  attempt happened. */
function buildRulesOnlyEntry(
  fields: MergeInputFields,
  priorEntry: AuctionExtraction | undefined,
  photos: CuratedPhoto[] | undefined,
  at: string,
): AuctionExtraction {
  const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
  const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
  const prevFailures = priorEntry?.llmFailures ?? 0
  return {
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
    photos,
    photosCheckedAt: priorEntry?.photosCheckedAt,
    photoPipelineVersion: priorEntry?.photoPipelineVersion,
    at,
    ...(prevFailures > 0 ? { llmFailures: prevFailures } : {}),
    ...(priorEntry?.photoFailures ? { photoFailures: priorEntry.photoFailures } : {}),
  }
}

/**
 * Re-derives one auction's AuctionExtraction from its archived 'auction'
 * capture (title/description/attachments — the same shape enrichOne would
 * have produced) and, if needed, its archived 'document' capture (the best
 * appraisal PDF's raw bytes). Mirrors enrich.ts's rules → LLM(text) →
 * LLM(vision) cascade, just against archived bytes instead of a live fetch —
 * no photo pipeline (out of scope for E2) and no detail-fetch bookkeeping
 * (the archived capture already *is* the fetched detail data). Additionally
 * feeds a gemini-native call the raw PDF bytes directly (native document
 * understanding) instead of pdftotext/rendered pages — enrich.ts doesn't do
 * this yet, see WP-E follow-up.
 * Returns null when the auction/PDF capture can't be found or read.
 */
export async function reprocessAuction(
  platform: string,
  externalId: string,
  priorEntry: AuctionExtraction | undefined,
  llmConfig: LlmConfig | null,
  at: string,
): Promise<{ entry: AuctionExtraction; llmCalled: boolean } | null> {
  const base = await buildReprocessInput(platform, externalId, priorEntry, llmConfig)
  if (!base) return null

  if (!llmConfig) {
    return { entry: buildRulesOnlyEntry(base.fields, priorEntry, base.photos, at), llmCalled: false }
  }

  const llm = await extractByLlm(base.input!, llmConfig)
  return { entry: mergeLlmResult(priorEntry, base.fields, llm, at, base.photos), llmCalled: true }
}

export default defineTask({
  meta: {
    name: 'reprocess',
    description:
      'Re-run rules/LLM extraction (incl. vision) against archived raw_captures — no live portal fetch. Manually triggered, for iterating on extraction prompts/rules.',
  },
  async run(event) {
    return { result: await runReprocess((event?.payload ?? {}) as ReprocessOptions) }
  },
})

export async function runReprocess(opts: ReprocessOptions = {}): Promise<ReprocessResult> {
  if (opts.force && !opts.platform && !opts.externalId && !opts.caseNumber && !opts.limit) {
    throw new Error(
      '[reprocess] force requires platform/externalId/caseNumber or limit — an unbounded forced run would re-spend the LLM budget on every already-extracted auction',
    )
  }

  const candidates = await findCandidates(opts)
  const cache = await readExtractionCache()
  const llmConfig = await readLlmConfig()
  const executionMode = await readLlmExecutionMode()
  const maxLlmPerRun = readMaxLlmPerRun()
  const at = new Date().toISOString()
  // Any provider without a Batch API integration falls back to the
  // synchronous path even if `batch: true` was requested.
  const batchRequested = opts.batch ?? executionMode === 'batch'
  const useBatch = batchRequested && supportsLlmBatch(llmConfig)

  let processed = 0
  let skipped = 0
  let llmCalls = 0
  const dirty: ExtractionCache = {}
  const batchItems: { key: string; input: LlmInput }[] = []

  for (const { platform, externalId } of candidates) {
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
          (llmConfig != null && hasMissingLlmOnlyField)) &&
          (priorEntry?.llmFailures ?? 0) < MAX_LLM_FAILURES &&
          !isLlmBatchPending(priorEntry))
      if (!eligible) {
        skipped++
        continue
      }

      if (useBatch) {
        const base = await buildReprocessInput(platform, externalId, priorEntry, llmConfig, {
          nativeDocuments: supportsNativeBatchDocuments(llmConfig),
        })
        if (!base || !base.input) {
          skipped++
          continue
        }
        batchItems.push({ key, input: base.input })
        const entry = buildRulesOnlyEntry(base.fields, priorEntry, base.photos, at)
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

      const useLlm = llmConfig && llmCalls < maxLlmPerRun ? llmConfig : null
      const result = await reprocessAuction(platform, externalId, priorEntry, useLlm, at)
      if (!result) {
        skipped++
        continue
      }
      if (result.llmCalled) llmCalls++

      cache[key] = result.entry
      dirty[key] = result.entry
      processed++

      // Keep the detail page (which reads auction_snapshot directly, not the
      // extraction_cache overlay) in sync for auctions actually touched here —
      // cheap since WP-5 made auction_snapshot a per-row Postgres upsert rather
      // than a whole-crawl JSON rewrite.
      const snapshot = await readAuctionSnapshot()
      const snapshotEntry = snapshot[key]
      if (snapshotEntry) {
        const updated: Auction = { ...snapshotEntry }
        applyExtractionToAuctions([updated], { [key]: result.entry })
        await writeAuctionSnapshot([updated])
      }
    } catch (err) {
      console.warn(`[reprocess] failed for ${platform}:${externalId}: ${(err as Error).message}`)
      skipped++
    }
  }

  if (batchItems.length > 0 && llmConfig) {
    const submission = await submitLlmBatch(batchItems, llmConfig, 'reprocess')
    if (submission) {
      // Same rationale as enrich.ts: mark every submitted item so a second
      // runReprocess({ batch: true }) call doesn't re-submit it to a new job
      // while this one is still in flight (job submission isn't idempotent).
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

  console.log(
    `[reprocess] candidates=${candidates.length} processed=${processed} skipped=${skipped} llmCalls=${llmCalls}`,
  )
  return { candidates: candidates.length, processed, skipped, llmCalls }
}
