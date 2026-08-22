import type { Attachment, Auction } from '~/types/auction'
import { getPool } from './db'
import { jsonbStringify } from './jsonb'
import { coerceRulesHint, type RulesHint } from './extract/llm-clamp'
import { cacheKey } from './verkehrswert-cache'

export interface AuctionFetchState {
  platform: string
  externalId: string
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  detailUrl: string | null
  detailUrlUpstream: string | null
  attachments: Attachment[]
  photoUrls: string[] | null
  sourceUpdatedIso: string | null
  detailFetchedAt: string | null
  enrichClaimedAt: string | null
  llmBatchJob: string | null
  llmArtifactVersionId: number | null
  llmRulesHint: RulesHint | null
  llmFailures: number
  llmLastAttemptedAt: string | null
  llmClaimedAt: string | null
  photosCheckedAt: string | null
  photoFailures: number
  photoLastAttemptedAt: string | null
  photoPipelineVersion: number | null
  updatedAt: string
}

interface AuctionFetchStateRow {
  platform: string
  external_id: string
  pdf_url: string | null
  pdf_url_upstream: string | null
  detail_url: string | null
  detail_url_upstream: string | null
  attachments: Attachment[] | null
  photo_urls: string[] | null
  source_updated_iso: Date | string | null
  detail_fetched_at: Date | string | null
  enrich_claimed_at: Date | string | null
  llm_batch_job: string | null
  llm_artifact_version_id: string | number | null
  llm_rules_hint: unknown
  llm_failures: number
  llm_last_attempted_at: Date | string | null
  llm_claimed_at: Date | string | null
  photos_checked_at: Date | string | null
  photo_failures: number
  photo_last_attempted_at: Date | string | null
  photo_pipeline_version: number | null
  updated_at: Date | string
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

function fromRow(row: AuctionFetchStateRow): AuctionFetchState {
  return {
    platform: row.platform,
    externalId: row.external_id,
    pdfUrl: row.pdf_url,
    pdfUrlUpstream: row.pdf_url_upstream,
    detailUrl: row.detail_url,
    detailUrlUpstream: row.detail_url_upstream,
    attachments: row.attachments ?? [],
    photoUrls: row.photo_urls,
    sourceUpdatedIso: iso(row.source_updated_iso),
    detailFetchedAt: iso(row.detail_fetched_at),
    enrichClaimedAt: iso(row.enrich_claimed_at),
    llmBatchJob: row.llm_batch_job,
    llmArtifactVersionId: row.llm_artifact_version_id == null ? null : Number(row.llm_artifact_version_id),
    llmRulesHint: coerceRulesHint(row.llm_rules_hint),
    llmFailures: row.llm_failures,
    llmLastAttemptedAt: iso(row.llm_last_attempted_at),
    llmClaimedAt: iso(row.llm_claimed_at),
    photosCheckedAt: iso(row.photos_checked_at),
    photoFailures: row.photo_failures,
    photoLastAttemptedAt: iso(row.photo_last_attempted_at),
    photoPipelineVersion: row.photo_pipeline_version,
    updatedAt: iso(row.updated_at)!,
  }
}

export async function readAuctionFetchState(platform: string, externalId: string): Promise<AuctionFetchState | null> {
  const db = getPool()
  if (!db) return null
  const { rows } = await db.query<AuctionFetchStateRow>(
    'SELECT * FROM auction_fetch_state WHERE platform = $1 AND external_id = $2',
    [platform, externalId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

export async function readAuctionFetchStates(): Promise<Map<string, AuctionFetchState>> {
  const db = getPool()
  if (!db) return new Map()
  const { rows } = await db.query<AuctionFetchStateRow>('SELECT * FROM auction_fetch_state')
  return new Map(rows.map((row) => {
    const state = fromRow(row)
    return [cacheKey(state.platform, state.externalId), state]
  }))
}

const CRAWL_COLUMNS = [
  'platform',
  'external_id',
  'pdf_url',
  'pdf_url_upstream',
  'detail_url',
  'detail_url_upstream',
  'attachments',
  'photo_urls',
  'source_updated_iso',
  'detail_fetched_at',
] as const

const CRAWL_CHUNK_SIZE = 500

/**
 * Persists crawler-owned fields without touching LLM/photo retry state. A
 * list-only crawl preserves an existing detail payload; once detailFetchedAt
 * is present, the incoming detail fields are authoritative even when empty.
 */
export async function writeAuctionCrawlFetchState(auctions: Auction[]): Promise<void> {
  const db = getPool()
  if (!db || auctions.length === 0) return
  const deduped = new Map<string, Auction>()
  for (const auction of auctions) deduped.set(cacheKey(auction.platform, auction.externalId), auction)
  const rows = [...deduped.values()]

  for (let start = 0; start < rows.length; start += CRAWL_CHUNK_SIZE) {
    const values: unknown[] = []
    const tuples: string[] = []
    for (const auction of rows.slice(start, start + CRAWL_CHUNK_SIZE)) {
      const row = [
        auction.platform,
        auction.externalId,
        auction.pdfUrl,
        auction.pdfUrlUpstream,
        auction.detailUrl,
        auction.detailUrlUpstream,
        jsonbStringify(auction.attachments),
        auction.photoUrls ?? null,
        auction.sourceUpdatedIso,
        auction.detailFetchedAt ?? null,
      ]
      tuples.push(`(${row.map((_, index) => `$${values.length + index + 1}`).join(', ')})`)
      values.push(...row)
    }
    await db.query(
      `INSERT INTO auction_fetch_state (${CRAWL_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (platform, external_id) DO UPDATE SET
         pdf_url = CASE WHEN EXCLUDED.detail_fetched_at IS NOT NULL THEN EXCLUDED.pdf_url ELSE COALESCE(EXCLUDED.pdf_url, auction_fetch_state.pdf_url) END,
         pdf_url_upstream = CASE WHEN EXCLUDED.detail_fetched_at IS NOT NULL THEN EXCLUDED.pdf_url_upstream ELSE COALESCE(EXCLUDED.pdf_url_upstream, auction_fetch_state.pdf_url_upstream) END,
         detail_url = CASE WHEN EXCLUDED.detail_fetched_at IS NOT NULL THEN EXCLUDED.detail_url ELSE COALESCE(EXCLUDED.detail_url, auction_fetch_state.detail_url) END,
         detail_url_upstream = CASE WHEN EXCLUDED.detail_fetched_at IS NOT NULL THEN EXCLUDED.detail_url_upstream ELSE COALESCE(EXCLUDED.detail_url_upstream, auction_fetch_state.detail_url_upstream) END,
         attachments = CASE WHEN EXCLUDED.detail_fetched_at IS NOT NULL THEN EXCLUDED.attachments ELSE auction_fetch_state.attachments END,
         photo_urls = CASE WHEN EXCLUDED.detail_fetched_at IS NOT NULL OR EXCLUDED.photo_urls IS NOT NULL THEN EXCLUDED.photo_urls ELSE auction_fetch_state.photo_urls END,
         source_updated_iso = COALESCE(EXCLUDED.source_updated_iso, auction_fetch_state.source_updated_iso),
         detail_fetched_at = COALESCE(EXCLUDED.detail_fetched_at, auction_fetch_state.detail_fetched_at),
         updated_at = now()`,
      values,
    )
  }
}

/** How long an enrich claim is trusted before crawl-status.ts's read-side
 *  falls it back to 'open'/'error' — a crashed worker (no per-item try/catch
 *  around enrich-worker.ts's loop body) leaves the claim stuck otherwise.
 *  Kept in sync by hand with the hardcoded interval literal in
 *  crawl-status.ts's STATUS_CTE. */
export const ENRICH_CLAIM_LEASE_MS = 15 * 60 * 1000

/** Marks/clears a single identity as currently being (re-)crawled, independent
 *  of the crawl/photo/LLM column groups above. Called once per identity right
 *  as an enrich-worker.ts worker picks it up, and cleared at the end of that
 *  same iteration. */
export async function writeAuctionEnrichClaim(platform: string, externalId: string, claimedAt: string | null): Promise<void> {
  const db = getPool()
  if (!db) return
  await db.query(
    `INSERT INTO auction_fetch_state (platform, external_id, enrich_claimed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       enrich_claimed_at = EXCLUDED.enrich_claimed_at,
       updated_at = now()`,
    [platform, externalId, claimedAt],
  )
}

export interface PhotoPipelineState {
  photosCheckedAt?: string | null
  photoFailures?: number
  photoPipelineVersion?: number | null
  /** Set only when an actual photo-pipeline attempt was made this write
   *  (whether it succeeded or failed) — as opposed to a write that leaves the
   *  prior failure count unchanged. enrich.ts's eligibility check reads this
   *  back to let a locked-out auction (photoFailures >= MAX_PHOTO_FAILURES)
   *  retry again after a cooldown instead of being excluded forever, mirroring
   *  llmAttempted/LLM_FAILURE_RETRY_COOLDOWN_HOURS. */
  photoAttempted?: boolean
}

/** Updates only photo-pipeline columns, preserving concurrent crawler/LLM writes. */
export async function writeAuctionPhotoPipelineState(
  platform: string,
  externalId: string,
  state: PhotoPipelineState,
): Promise<void> {
  const db = getPool()
  if (!db) return
  await db.query(
    `INSERT INTO auction_fetch_state
       (platform, external_id, photos_checked_at, photo_failures, photo_last_attempted_at, photo_pipeline_version)
     VALUES ($1, $2, $3, $4, CASE WHEN $6 THEN now() ELSE NULL END, $5)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       photos_checked_at = EXCLUDED.photos_checked_at,
       photo_failures = EXCLUDED.photo_failures,
       photo_last_attempted_at = CASE WHEN $6 THEN now() ELSE auction_fetch_state.photo_last_attempted_at END,
       photo_pipeline_version = EXCLUDED.photo_pipeline_version,
       updated_at = now()`,
    [
      platform,
      externalId,
      state.photosCheckedAt ?? null,
      state.photoFailures ?? 0,
      state.photoPipelineVersion ?? null,
      state.photoAttempted ?? false,
    ],
  )
}

export interface LlmPipelineState {
  llmBatchJob: string | null
  llmArtifactVersionId: number | null
  /** Only set alongside llmBatchJob when a batch item is submitted — the
   *  rules values the LLM was asked to verify, so llm-batch-poll can tell
   *  whether a returned verdict still refers to today's value. Cleared with
   *  the rest of the batch marker on merge. */
  llmRulesHint: RulesHint | null
  llmFailures: number
  /** Set only when an actual LLM request was made this write (whether it
   *  succeeded or failed) — as opposed to a rules-only entry persisted with
   *  the prior failure count unchanged. reprocess.ts's eligibility check
   *  reads this back to let a locked-out auction (llm_failures >=
   *  MAX_LLM_FAILURES) retry again after a cooldown instead of being
   *  excluded forever — see LLM_FAILURE_RETRY_COOLDOWN_HOURS. */
  llmAttempted?: boolean
}

/** Updates only LLM-pipeline columns, preserving concurrent crawler/photo writes.
 *  Always clears llm_claimed_at: every call site represents this item's LLM
 *  attempt having just resolved (success or failure), see writeAuctionLlmClaim. */
export async function writeAuctionLlmPipelineState(
  platform: string,
  externalId: string,
  state: LlmPipelineState,
): Promise<void> {
  const db = getPool()
  if (!db) return
  await db.query(
    `INSERT INTO auction_fetch_state
       (platform, external_id, llm_batch_job, llm_artifact_version_id, llm_rules_hint, llm_failures, llm_last_attempted_at, llm_claimed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $7 THEN now() ELSE NULL END, NULL)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       llm_batch_job = EXCLUDED.llm_batch_job,
       llm_artifact_version_id = EXCLUDED.llm_artifact_version_id,
       llm_rules_hint = EXCLUDED.llm_rules_hint,
       llm_failures = EXCLUDED.llm_failures,
       llm_last_attempted_at = CASE WHEN $7 THEN now() ELSE auction_fetch_state.llm_last_attempted_at END,
       llm_claimed_at = NULL,
       updated_at = now()`,
    [
      platform,
      externalId,
      state.llmBatchJob,
      state.llmArtifactVersionId,
      state.llmRulesHint == null ? null : jsonbStringify(state.llmRulesHint),
      state.llmFailures,
      state.llmAttempted ?? false,
    ],
  )
}

/** How long a sync LLM claim is trusted before llm-status.ts's read-side falls
 *  it back to 'error'/'open' — claude-proxy.ts's own request timeout is 120s
 *  plus a handful of transient retries, so a real in-flight call never
 *  approaches this; it only matters for a run that died mid-item. */
export const LLM_CLAIM_LEASE_MS = 10 * 60 * 1000

/** Marks a single identity as currently undergoing a synchronous LLM call —
 *  set right before reprocess-run.ts's sync reprocessAuction() call, cleared
 *  by the writeAuctionLlmPipelineState() write that already follows it
 *  (success or failure). Deliberately its own narrow writer rather than a
 *  field on LlmPipelineState: the caller doesn't know llmFailures/llmBatchJob
 *  yet at claim time. Not used for the batch-submission path — a
 *  provider-batch job already has its own lifecycle via llm_batch_job. */
export async function writeAuctionLlmClaim(platform: string, externalId: string, claimedAt: string | null): Promise<void> {
  const db = getPool()
  if (!db) return
  await db.query(
    `INSERT INTO auction_fetch_state (platform, external_id, llm_claimed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       llm_claimed_at = EXCLUDED.llm_claimed_at,
       updated_at = now()`,
    [platform, externalId, claimedAt],
  )
}

/** Applies mutable state after the immutable auction/details aggregate is read. */
export function applyAuctionFetchState(auction: Auction, state: AuctionFetchState | null): Auction {
  if (!state) return auction
  auction.pdfUrl = state.pdfUrl
  auction.pdfUrlUpstream = state.pdfUrlUpstream
  auction.detailUrl = state.detailUrl
  auction.detailUrlUpstream = state.detailUrlUpstream
  auction.attachments = state.attachments
  auction.photoUrls = state.photoUrls ?? undefined
  auction.sourceUpdatedIso = state.sourceUpdatedIso
  auction.detailFetchedAt = state.detailFetchedAt
  auction.processing = {
    llmBatchJob: state.llmBatchJob,
    llmFailures: state.llmFailures,
    llmClaimedAt: state.llmClaimedAt,
    photosCheckedAt: state.photosCheckedAt,
    photoFailures: state.photoFailures,
    photoPipelineVersion: state.photoPipelineVersion,
  }
  return auction
}
