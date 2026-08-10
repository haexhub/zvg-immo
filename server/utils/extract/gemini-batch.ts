// Gemini Batch API client: submits a whole enrich/reprocess run's LLM work
// as one job instead of hundreds of synchronous generateContent calls (see
// docs/plans — the Gemini Batch-API-Umstellung plan). Reuses the exact same
// prompt/schema/parsing building blocks as the synchronous gemini-native
// path (buildParts/SYSTEM_PROMPT/UNIVERSAL_AUCTION_SCHEMA from ./llm,
// toGeminiParts/parseGeminiExtractionResponse from ./providers/gemini-native,
// toGeminiSchema from ./providers/gemini-schema) — no duplicated prompt logic.
//
// *** VERIFIED LIVE 2026-07-27: free tier has no Batch API access at all ***
// batchGenerateContent rejects every request with 400 FAILED_PRECONDITION —
// confirmed against the real API with a valid uploaded JSONL file, not just a
// malformed one — while sync generateContent on the same key works fine.
// Google's own docs back this up: Batch API rate limits are only defined for
// paid Tier 1-3 accounts, and FAILED_PRECONDITION on this endpoint is
// documented as "enable billing on your project". The free-tier quota guard
// below (maxJobsPerDay etc.) was written assuming free tier could batch, just
// slowly — that assumption was wrong, so `supportsLlmBatch` (./llm-batch.ts)
// gates gemini-native on `isGeminiBatchTierPaid()` and never lets this path
// run at all while geminiBatchTier stays 'free'. The guard logic remains
// dormant, ready for when NUXT_EXTRACT_LLM_GEMINI_BATCH_TIER=paid is set.
// Rather than trust only that static config flag an admin has to remember to
// set correctly, every real submit attempt below also records its outcome
// via recordLlmBatchCapability (../llm-batch-jobs.ts) — enrich.ts/reprocess.ts
// read that alongside supportsLlmBatch so a confirmed-broken provider falls
// back to the synchronous path automatically instead of submitting doomed
// jobs run after run, and /settings surfaces the real error instead of a
// silent stuck backlog.
// `pollGeminiBatch`'s and `fetchGeminiBatchResults`' exact REST JSON field
// paths (job state location, result-file field, per-item error envelope) are
// still UNVERIFIED — no job has ever been accepted by Google to poll/fetch
// against. `extractState`/`extractResultFileName` below check several
// plausible field paths defensively so a layout mismatch surfaces as a
// warning + 'pending'/'failed' state rather than a silent misparse, but this
// must still be confirmed against a real completed job once billing is on.

import {
  buildParts,
  clampExtraction,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  type ClampedExtraction,
  type LlmConfig,
  type LlmInput,
} from './llm'
import { DEFAULT_MODEL, parseGeminiExtractionResponse, toGeminiParts } from './providers/gemini-native'
import { toGeminiSchema } from './providers/gemini-schema'
import { apiBase, extractOfetchErrorMessage, isTransientBatchError } from './batch-shared'
import {
  insertLlmBatchJob,
  readGeminiBatchQuotaUsage,
  recordGeminiBatchQuotaUsage,
  recordLlmBatchCapability,
  setGeminiBatchQuotaBackoff,
  type GeminiBatchQuotaUsage,
  withGeminiBatchQuotaLock,
} from '../llm-batch-jobs'
export { fetchGeminiBatchResults, pollGeminiBatch, type PollResult } from './gemini-batch-client'

interface GeminiBatchQuotaPolicy {
  tier: 'free' | 'paid'
  maxJobsPerDay: number | null
  maxItemsPerBatch: number
  maxEstimatedTokensPerBatch: number | null
}

export interface GeminiBatchSubmitResult {
  jobName: string
  submitted: Array<{ key: string; jobName: string }>
  retryItems: Array<{ key: string; input: LlmInput }>
}

const DEFAULT_FREE_BATCH_MAX_JOBS_PER_DAY = 1
const DEFAULT_FREE_BATCH_MAX_ITEMS = 5
const DEFAULT_FREE_BATCH_MAX_ESTIMATED_TOKENS = 100_000
const DEFAULT_PAID_BATCH_MAX_ITEMS = 300
const MIN_BATCH_ITEMS = 1

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextUtcDayIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const raw = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback
}

function parseOptionalPositiveInt(value: unknown, fallback: number | null): number | null {
  if (value === '' || value == null) return fallback
  const raw = typeof value === 'string' ? Number(value) : value
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback
}

// Google rejects every gemini-native batchGenerateContent call with 400
// FAILED_PRECONDITION on a free-tier key (see the module header) — so
// supportsLlmBatch (./llm-batch.ts) calls this to keep enrich.ts/reprocess.ts
// on the synchronous path until billing is enabled for the project.
export function isGeminiBatchTierPaid(): boolean {
  return readGeminiBatchQuotaPolicy().tier === 'paid'
}

function readGeminiBatchQuotaPolicy(): GeminiBatchQuotaPolicy {
  const extractLlm =
    typeof useRuntimeConfig === 'function'
      ? (useRuntimeConfig().extractLlm as Record<string, unknown> | undefined)
      : undefined
  const tier = extractLlm?.geminiBatchTier === 'paid' ? 'paid' : 'free'
  if (tier === 'paid') {
    return {
      tier,
      maxJobsPerDay: null,
      maxItemsPerBatch: Math.max(
        MIN_BATCH_ITEMS,
        parsePositiveInt(extractLlm?.geminiPaidBatchMaxItems, DEFAULT_PAID_BATCH_MAX_ITEMS),
      ),
      maxEstimatedTokensPerBatch: null,
    }
  }
  return {
    tier,
    maxJobsPerDay: Math.max(
      1,
      parsePositiveInt(extractLlm?.geminiFreeBatchMaxJobsPerDay, DEFAULT_FREE_BATCH_MAX_JOBS_PER_DAY),
    ),
    maxItemsPerBatch: Math.max(
      MIN_BATCH_ITEMS,
      parsePositiveInt(extractLlm?.geminiFreeBatchMaxItems, DEFAULT_FREE_BATCH_MAX_ITEMS),
    ),
    maxEstimatedTokensPerBatch: parseOptionalPositiveInt(
      extractLlm?.geminiFreeBatchMaxEstimatedTokens,
      DEFAULT_FREE_BATCH_MAX_ESTIMATED_TOKENS,
    ),
  }
}

function estimateTokens(json: string): number {
  // Conservative cheap estimate for deciding batch size before upload. Exact
  // CountTokens would itself add requests; base64/PDF-heavy payloads are the
  // reason this guard exists, so we bias toward smaller free-tier batches.
  return Math.ceil(Buffer.byteLength(json, 'utf8') / 4)
}

function backoffActive(usage: GeminiBatchQuotaUsage): boolean {
  if (!usage.backoffUntil) return false
  const until = Date.parse(usage.backoffUntil)
  return Number.isFinite(until) && until > Date.now()
}

function isGeminiQuotaError(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } })?.status
  const statusCode =
    typeof status === 'number'
      ? status
      : (err as { statusCode?: unknown; response?: { status?: unknown } })?.statusCode
  const responseStatus = (err as { response?: { status?: unknown } })?.response?.status
  if (statusCode === 429 || responseStatus === 429) return true
  const message = err instanceof Error ? err.message : String(err)
  return /quota|rate.?limit|resource_exhausted|too many requests/i.test(message)
}

// isTransientBatchError (imported from ./batch-shared) also treats a 429 as
// transient, unlike the version this file used to keep locally — harmless
// here since isGeminiQuotaError above always intercepts a real 429 first and
// returns before isTransientBatchError is ever consulted.

function selectLineItemsForQuota(
  lineItems: Array<{ item: { key: string; input: LlmInput }; line: string }>,
  policy: GeminiBatchQuotaPolicy,
): {
  selected: Array<{ item: { key: string; input: LlmInput }; line: string; estimatedTokens: number }>
  retryItems: Array<{ key: string; input: LlmInput }>
  estimatedTokens: number
} {
  const selected: Array<{ item: { key: string; input: LlmInput }; line: string; estimatedTokens: number }> = []
  const retryItems: Array<{ key: string; input: LlmInput }> = []
  let totalEstimatedTokens = 0
  for (const entry of lineItems) {
    const itemEstimatedTokens = estimateTokens(entry.line)
    const itemLimitExceeded =
      policy.maxEstimatedTokensPerBatch != null && itemEstimatedTokens > policy.maxEstimatedTokensPerBatch
    const batchLimitExceeded =
      policy.maxEstimatedTokensPerBatch != null &&
      totalEstimatedTokens + itemEstimatedTokens > policy.maxEstimatedTokensPerBatch
    if (
      selected.length >= policy.maxItemsPerBatch ||
      itemLimitExceeded ||
      (batchLimitExceeded && selected.length > 0)
    ) {
      retryItems.push(entry.item)
      continue
    }
    if (batchLimitExceeded) {
      retryItems.push(entry.item)
      continue
    }
    selected.push({ ...entry, estimatedTokens: itemEstimatedTokens })
    totalEstimatedTokens += itemEstimatedTokens
  }
  return { selected, retryItems, estimatedTokens: totalEstimatedTokens }
}

function buildJsonlLine(key: string, input: LlmInput): string | null {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  return JSON.stringify({
    key,
    request: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: toGeminiParts(parts) }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(UNIVERSAL_AUCTION_SCHEMA),
      },
    },
  })
}

function extractBatchJobName(resp: { name?: unknown; batch?: { name?: unknown }; response?: { name?: unknown } }): string | null {
  for (const candidate of [resp.name, resp.batch?.name, resp.response?.name]) {
    if (typeof candidate === 'string' && candidate.startsWith('batches/')) return candidate
  }
  return null
}

/** 3-step resumable upload (start → get upload URL from response header →
 *  upload+finalize) — see ai.google.dev's Files API docs. Returns the
 *  uploaded file's resource name (`files/...`), or null on any failure. */
async function uploadJsonl(jsonl: string, config: LlmConfig): Promise<string | null> {
  const bytes = Buffer.from(jsonl, 'utf8')
  const start = await $fetch.raw(`${apiBase(config)}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': config.apiKey ?? '',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Header-Content-Type': 'application/jsonl',
      'content-type': 'application/json',
    },
    body: { file: { display_name: `zvg-immo-batch-${Date.now()}` } },
    signal: AbortSignal.timeout(30_000),
  })
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (!uploadUrl) {
    console.warn('[gemini-batch] resumable upload start did not return an x-goog-upload-url header')
    return null
  }
  const finalize = await $fetch<{ file?: { name?: string } }>(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'content-type': 'application/octet-stream',
    },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  })
  return finalize.file?.name ?? null
}

/**
 * Builds the JSONL, applies the configured Gemini Batch quota guard, uploads
 * the selected lines, and submits a batchGenerateContent job. Returns the
 * submitted keys plus retryable leftovers so callers mark only work that
 * actually reached Google.
 */
export async function submitGeminiBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<GeminiBatchSubmitResult | null> {
  const lineItems = items
    .map((item) => ({ item, line: buildJsonlLine(item.key, item.input) }))
    .filter((entry): entry is { item: { key: string; input: LlmInput }; line: string } => entry.line != null)
  if (lineItems.length === 0) return null
  return withGeminiBatchQuotaLock(() => submitGeminiBatchLocked(lineItems, config, source))
}

async function submitGeminiBatchLocked(
  lineItems: Array<{ item: { key: string; input: LlmInput }; line: string }>,
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<GeminiBatchSubmitResult | null> {
  const policy = readGeminiBatchQuotaPolicy()
  const quotaDay = todayUtc()
  const usage = await readGeminiBatchQuotaUsage(quotaDay)
  if (policy.maxJobsPerDay != null && usage.jobs >= policy.maxJobsPerDay) {
    console.warn(
      `[gemini-batch] ${policy.tier} tier quota guard skipped submit: ${usage.jobs}/${policy.maxJobsPerDay} batch job(s) already submitted for ${quotaDay}`,
    )
    return null
  }
  if (backoffActive(usage)) {
    console.warn(`[gemini-batch] quota backoff active until ${usage.backoffUntil} — skipping submit`)
    return null
  }
  const selection = selectLineItemsForQuota(lineItems, policy)
  if (selection.selected.length === 0) {
    console.warn(
      `[gemini-batch] ${policy.tier} tier quota guard found no item small enough for one batch (maxEstimatedTokens=${policy.maxEstimatedTokensPerBatch ?? 'off'})`,
    )
    return null
  }
  const lines = selection.selected.map((entry) => entry.line)
  if (selection.retryItems.length > 0) {
    console.warn(
      `[gemini-batch] ${policy.tier} tier quota guard selected ${selection.selected.length}/${lineItems.length} item(s); ${selection.retryItems.length} left for a later run`,
    )
  }
  // Google may return file results in input order without echoing the JSONL
  // `key` on every line. Persist an ordinal fallback so the poller can still
  // merge each response into the right structured auction entry.
  const customIdMap = Object.fromEntries(selection.selected.map((entry, index) => [String(index), entry.item.key]))
  const model = config.model || DEFAULT_MODEL
  try {
    const fileName = await uploadJsonl(lines.join('\n'), config)
    if (!fileName) {
      const message = 'resumable upload did not return a usable file'
      console.warn(`[gemini-batch] ${message}`)
      await recordLlmBatchCapability('gemini-native', { ok: false, message, source })
      return null
    }
    const batch = await $fetch<{ name?: string; batch?: { name?: string }; response?: { name?: string } }>(`${apiBase(config)}/v1beta/models/${model}:batchGenerateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey ?? '' },
      body: { batch: { display_name: `zvg-immo-${source}`, input_config: { file_name: fileName } } },
      signal: AbortSignal.timeout(30_000),
    })
    const jobName = extractBatchJobName(batch)
    if (!jobName) {
      const message = 'batchGenerateContent response had no job name'
      console.warn(`[gemini-batch] ${message}`)
      await recordLlmBatchCapability('gemini-native', { ok: false, message, source })
      return null
    }
    // Google accepted the request — batch submission itself works for this
    // account/model, independent of whether our own bookkeeping below does.
    await recordLlmBatchCapability('gemini-native', { ok: true, message: null, source })
    // The job is accepted by Google at this point and consumes quota even if
    // our local job row insert fails and the batch becomes orphaned.
    await recordGeminiBatchQuotaUsage(quotaDay, {
      jobs: 1,
      items: selection.selected.length,
      estimatedTokens: selection.estimatedTokens,
    })
    const recorded = await insertLlmBatchJob({ jobName, source, itemCount: lines.length, customIdMap })
    if (!recorded) {
      console.warn(`[gemini-batch] failed to record job ${jobName} — treating submission as failed`)
      return null
    }
    return {
      jobName,
      submitted: selection.selected.map((entry) => ({ key: entry.item.key, jobName })),
      retryItems: selection.retryItems,
    }
  } catch (err) {
    const message = extractOfetchErrorMessage(err)
    if (isGeminiQuotaError(err)) {
      // Rate-limited, not incapable — proves the account CAN batch, just not
      // right now. Don't flip capability to broken over a transient 429.
      await setGeminiBatchQuotaBackoff(quotaDay, nextUtcDayIso())
      console.warn(`[gemini-batch] submit failed: ${message}`)
      return null
    }
    if (isTransientBatchError(err)) {
      // Timeout/connection failure/5xx — inconclusive about whether the
      // account can batch at all, so don't flip capability to broken either.
      console.warn(`[gemini-batch] submit failed (transient): ${message}`)
      return null
    }
    console.warn(`[gemini-batch] submit failed: ${message}`)
    await recordLlmBatchCapability('gemini-native', { ok: false, message, source })
    return null
  }
}
