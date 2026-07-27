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
import {
  insertLlmBatchJob,
  readGeminiBatchQuotaUsage,
  recordGeminiBatchQuotaUsage,
  setGeminiBatchQuotaBackoff,
  type GeminiBatchQuotaUsage,
  withGeminiBatchQuotaLock,
} from '../llm-batch-jobs'

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

function apiBase(config: LlmConfig): string {
  return config.baseUrl.replace(/\/$/, '')
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
  // merge each response into the right extraction-cache entry.
  const customIdMap = Object.fromEntries(selection.selected.map((entry, index) => [String(index), entry.item.key]))
  const model = config.model || DEFAULT_MODEL
  try {
    const fileName = await uploadJsonl(lines.join('\n'), config)
    if (!fileName) return null
    const batch = await $fetch<{ name?: string; batch?: { name?: string }; response?: { name?: string } }>(`${apiBase(config)}/v1beta/models/${model}:batchGenerateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey ?? '' },
      body: { batch: { display_name: `zvg-immo-${source}`, input_config: { file_name: fileName } } },
      signal: AbortSignal.timeout(30_000),
    })
    const jobName = extractBatchJobName(batch)
    if (!jobName) {
      console.warn('[gemini-batch] batchGenerateContent response had no job name')
      return null
    }
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
    if (isGeminiQuotaError(err)) {
      await setGeminiBatchQuotaBackoff(quotaDay, nextUtcDayIso())
    }
    console.warn(`[gemini-batch] submit failed: ${(err as Error).message}`)
    return null
  }
}

export interface PollResult {
  state: 'pending' | 'succeeded' | 'failed' | 'expired'
  resultFileName?: string
}

const SUCCEEDED_STATES = new Set(['JOB_STATE_SUCCEEDED', 'BATCH_STATE_SUCCEEDED', 'SUCCEEDED'])
const FAILED_STATES = new Set([
  'JOB_STATE_FAILED',
  'BATCH_STATE_FAILED',
  'FAILED',
  'JOB_STATE_CANCELLED',
  'BATCH_STATE_CANCELLED',
  'CANCELLED',
])
const EXPIRED_STATES = new Set(['JOB_STATE_EXPIRED', 'BATCH_STATE_EXPIRED', 'EXPIRED'])

// See the module-level UNVERIFIED note — checks several plausible field
// paths rather than committing to one unconfirmed layout.
function extractState(resp: Record<string, unknown>): string | null {
  const metadata = resp.metadata as Record<string, unknown> | undefined
  const batch = (resp as { batch?: Record<string, unknown> }).batch
  for (const c of [metadata?.state, resp.state, batch?.state]) {
    if (typeof c === 'string') return c
  }
  return null
}

function extractResultFileName(resp: Record<string, unknown>): string | null {
  const response = resp.response as Record<string, unknown> | undefined
  const output = response?.output as Record<string, unknown> | undefined
  const destination = response?.destination as Record<string, unknown> | undefined
  const dest = resp.dest as Record<string, unknown> | undefined
  const batch = resp.batch as Record<string, unknown> | undefined
  const batchOutput = batch?.output as Record<string, unknown> | undefined
  const batchDest = batch?.dest as Record<string, unknown> | undefined
  for (const c of [
    output?.responsesFile,
    output?.responses_file,
    destination?.fileName,
    destination?.file_name,
    response?.responsesFile,
    response?.responses_file,
    dest?.fileName,
    dest?.file_name,
    batchOutput?.responsesFile,
    batchOutput?.responses_file,
    batchDest?.fileName,
    batchDest?.file_name,
  ]) {
    if (typeof c === 'string') return c
  }
  return null
}

export async function pollGeminiBatch(jobName: string, config: LlmConfig): Promise<PollResult> {
  try {
    const resp = await $fetch<Record<string, unknown>>(`${apiBase(config)}/v1beta/${jobName}`, {
      headers: { 'x-goog-api-key': config.apiKey ?? '' },
      signal: AbortSignal.timeout(30_000),
    })
    const state = extractState(resp)
    if (!state) {
      console.warn(`[gemini-batch] poll response for ${jobName} had no recognizable state field — treating as pending`)
      return { state: 'pending' }
    }
    if (SUCCEEDED_STATES.has(state)) {
      const resultFileName = extractResultFileName(resp)
      if (!resultFileName) {
        console.warn(`[gemini-batch] job ${jobName} reported success but no result file name was found`)
        return { state: 'failed' }
      }
      return { state: 'succeeded', resultFileName }
    }
    if (FAILED_STATES.has(state)) return { state: 'failed' }
    if (EXPIRED_STATES.has(state)) return { state: 'expired' }
    return { state: 'pending' }
  } catch (err) {
    console.warn(`[gemini-batch] poll failed for ${jobName}: ${(err as Error).message}`)
    return { state: 'pending' }
  }
}

/** Downloads and parses the result JSONL, one `{key, response|error}` line
 *  per submitted item — reuses the same response parser/clamping as the
 *  synchronous gemini-native path. A line with an `error` (per-item
 *  generation failure) or an unparseable response yields `extraction: null`,
 *  same contract as a failed synchronous call. */
export async function fetchGeminiBatchResults(
  resultFileName: string,
  config: LlmConfig,
  customIdMap: Record<string, string> = {},
): Promise<{ key: string; extraction: ClampedExtraction | null }[]> {
  try {
    const text = await $fetch<string>(`${apiBase(config)}/download/v1beta/${resultFileName}:download`, {
      query: { alt: 'media' },
      headers: { 'x-goog-api-key': config.apiKey ?? '' },
      signal: AbortSignal.timeout(120_000),
      responseType: 'text',
    })
    const out: { key: string; extraction: ClampedExtraction | null }[] = []
    let lineIndex = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const indexKey = String(lineIndex++)
      let parsed: { key?: unknown; metadata?: unknown; response?: unknown; error?: unknown; candidates?: unknown }
      try {
        parsed = JSON.parse(trimmed) as typeof parsed
      } catch (err) {
        console.warn(`[gemini-batch] failed to parse result line: ${(err as Error).message}`)
        continue
      }
      const metadata = parsed.metadata as Record<string, unknown> | undefined
      const key =
        typeof parsed.key === 'string'
          ? parsed.key
          : typeof metadata?.key === 'string'
            ? metadata.key
            : customIdMap[indexKey]
      if (typeof key !== 'string') continue
      const response = parsed.response ?? (Array.isArray(parsed.candidates) ? parsed : null)
      const raw = parsed.error ? null : parseGeminiExtractionResponse(response)
      out.push({ key, extraction: raw ? clampExtraction(raw) : null })
    }
    return out
  } catch (err) {
    console.warn(`[gemini-batch] fetch results failed: ${(err as Error).message}`)
    return []
  }
}
