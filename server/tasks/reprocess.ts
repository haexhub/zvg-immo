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

import type { Auction, AuctionExtraction } from '~/types/auction'
import { getPool } from '../utils/db'
import { pickBestPdf, extractPdfTextFromBuffer } from '../utils/extract/pdf-text'
import { renderPdfPagesJpeg } from '../utils/extract/pdf-render'
import { extractByRules } from '../utils/extract/rules'
import { extractByLlm, type LlmConfig } from '../utils/extract/llm'
import {
  applyExtractionToAuctions,
  readExtractionCache,
  writeExtractionCache,
  type ExtractionCache,
} from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'
import { downloadBlob, findLatestCapture } from '../utils/storage-download'
import { cacheKey } from '../utils/verkehrswert-cache'
import { normalizePhoto } from '~/lib/photo'

const DEFAULT_COUNTRY = 'de'
// Same heuristic as server/tasks/enrich.ts: below this, pdftotext's output is
// almost certainly scanned-image noise rather than the Gutachten's real text.
const SCANNED_PDF_TEXT_THRESHOLD = 200
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
   *  auctions already extracted. Requires platform/externalId/caseNumber so
   *  an unbounded forced re-run of an entire country can't happen by accident. */
  force?: boolean
}

export interface ReprocessResult {
  candidates: number
  processed: number
  skipped: number
  llmCalls: number
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
  const { rows } = await db.query<{ platform: string; external_id: string }>(
    `SELECT DISTINCT platform, external_id FROM raw_captures WHERE ${conditions.join(' AND ')}`,
    params,
  )
  return rows.map((r) => ({ platform: r.platform, externalId: r.external_id }))
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
  const fields = {
    propertyType: rules.propertyType,
    landAreaSqm: auction.sourceLandAreaSqm ?? rules.landAreaSqm,
    livingAreaSqm: auction.sourceLivingAreaSqm ?? rules.livingAreaSqm,
    rooms: auction.sourceRooms ?? rules.rooms,
    units: rules.units,
    securityDeposit: auction.sourceSecurityDeposit ?? rules.securityDeposit,
    biddingNotes: priorEntry?.biddingNotes,
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
  let source: 'rules' | 'llm' = 'rules'
  let llmCalled = false
  let llmFailed = false
  let llmSucceeded = false

  // Rules/structured values are a merge input, not a gate: call the LLM
  // whenever configured (findCandidates/runReprocess already bound how many
  // auctions reach here) so even a mergedConfident entry still picks up
  // condition/features/yearBuilt/insights instead of waiting for a later,
  // separately-triggered backfill pass (mirrors the same change in enrich.ts).
  if (llmConfig) {
    const bestPdf = pickBestPdf(auction.attachments)
    let pdfBytes: Buffer | null = null
    if (bestPdf) {
      const docCapture = await findLatestCapture('document', platform, externalId, bestPdf.proxyUrl)
      if (docCapture) pdfBytes = await downloadBlob(docCapture.contentHash)
    }
    // Native document understanding (GeminiNativeProvider) reads the PDF
    // bytes directly and needs neither pdftotext nor rendered page images —
    // skip both so a gemini-native run doesn't pay for pdftotext/rasterize
    // work that buildParts would discard anyway (it prefers pdfBytes over
    // pdfText/pdfPageImages once set).
    const usingNativeDoc = llmConfig.provider === 'gemini-native'
    const pdfText = pdfBytes && !usingNativeDoc ? await extractPdfTextFromBuffer(pdfBytes) : null
    const pdfPageImages =
      pdfBytes && !usingNativeDoc && (!pdfText || pdfText.trim().length < SCANNED_PDF_TEXT_THRESHOLD)
        ? (await renderPdfPagesJpeg(pdfBytes)).map((buf) => buf.toString('base64'))
        : null
    const nativeDocBytes = pdfBytes && usingNativeDoc ? pdfBytes.toString('base64') : null

    llmCalled = true
    const llm = await extractByLlm(
      { title: auction.title, description: auction.description, pdfText, pdfPageImages, pdfBytes: nativeDocBytes },
      llmConfig,
    )
    if (llm === null) {
      llmFailed = true
    } else {
      llmSucceeded = true
      // Only let the LLM contribute propertyType/sizes when rules didn't
      // already resolve them confidently — otherwise this call ran purely to
      // backfill condition/features/yearBuilt/insights (same trade-off as enrich.ts).
      if (!mergedConfident) {
        source = 'llm'
        fields.propertyType =
          fields.propertyType != null && fields.propertyType !== 'sonstiges'
            ? fields.propertyType
            : llm.propertyType
        fields.landAreaSqm = fields.landAreaSqm ?? llm.landAreaSqm
        fields.livingAreaSqm = fields.livingAreaSqm ?? llm.livingAreaSqm
        fields.rooms = fields.rooms ?? llm.rooms
        fields.units = fields.units ?? llm.units
        fields.securityDeposit = fields.securityDeposit ?? llm.securityDeposit
        fields.biddingNotes = llm.biddingNotes
      }
      fields.condition = llm.condition
      fields.features = llm.features
      fields.yearBuilt = llm.yearBuilt
      fields.lastRenovationYear = llm.lastRenovationYear
      fields.renovationNotes = llm.renovationNotes
      fields.insights = llm.insights
    }
  }

  const hasType = fields.propertyType != null && fields.propertyType !== 'sonstiges'
  const hasArea = fields.landAreaSqm != null || fields.livingAreaSqm != null
  const prevFailures = priorEntry?.llmFailures ?? 0
  const llmFailures = llmFailed ? prevFailures + 1 : llmSucceeded ? 0 : prevFailures

  const entry: AuctionExtraction = {
    ...fields,
    source,
    confidence: hasType && hasArea ? 'high' : 'low',
    // Photo re-extraction is out of scope for WP-6 (E2 is about rules/LLM
    // prompt iteration) — carry the prior result forward, but normalize so a
    // legacy prior entry's bare filename strings aren't re-persisted raw.
    photos: priorEntry?.photos?.map(normalizePhoto),
    at,
    ...(llmFailures > 0 ? { llmFailures } : {}),
  }
  return { entry, llmCalled }
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
  if (opts.force && !opts.platform && !opts.externalId && !opts.caseNumber) {
    throw new Error(
      '[reprocess] force requires platform/externalId/caseNumber — an unfiltered forced run would re-spend the LLM budget on every already-extracted auction',
    )
  }

  const candidates = await findCandidates(opts)
  const cache = await readExtractionCache()
  const llmConfig = readLlmConfig()
  const maxLlmPerRun = readMaxLlmPerRun()
  const at = new Date().toISOString()

  let processed = 0
  let skipped = 0
  let llmCalls = 0
  const dirty: ExtractionCache = {}

  for (const { platform, externalId } of candidates) {
    try {
      const key = cacheKey(platform, externalId)
      const priorEntry = cache[key]
      const eligible =
        opts.force ||
        ((!priorEntry ||
          (priorEntry.source === 'rules' && priorEntry.confidence === 'low') ||
          priorEntry.condition === undefined ||
          priorEntry.features === undefined ||
          priorEntry.yearBuilt === undefined ||
          priorEntry.lastRenovationYear === undefined ||
          priorEntry.renovationNotes === undefined ||
          priorEntry.insights === undefined) &&
          (priorEntry?.llmFailures ?? 0) < MAX_LLM_FAILURES)
      if (!eligible) {
        skipped++
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

  if (Object.keys(dirty).length > 0) await writeExtractionCache(dirty)

  console.log(
    `[reprocess] candidates=${candidates.length} processed=${processed} skipped=${skipped} llmCalls=${llmCalls}`,
  )
  return { candidates: candidates.length, processed, skipped, llmCalls }
}
