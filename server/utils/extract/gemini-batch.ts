// Gemini Batch API client: submits a whole enrich/reprocess run's LLM work
// as one job instead of hundreds of synchronous generateContent calls (see
// docs/plans — the Gemini Batch-API-Umstellung plan). Reuses the exact same
// prompt/schema/parsing building blocks as the synchronous gemini-native
// path (buildParts/SYSTEM_PROMPT/UNIVERSAL_AUCTION_SCHEMA from ./llm,
// toGeminiParts/parseGeminiExtractionResponse from ./providers/gemini-native,
// toGeminiSchema from ./providers/gemini-schema) — no duplicated prompt logic.
//
// *** UNVERIFIED — READ BEFORE RELYING ON THIS IN PRODUCTION ***
// The resumable-upload dance (uploadJsonl below) follows Google's standard
// X-Goog-Upload-* protocol, used identically across several Google APIs — is fairly
// safe. `pollGeminiBatch`'s and `fetchGeminiBatchResults`' exact REST JSON
// field paths (job state location, result-file field, per-item error
// envelope) are NOT: at the time this was written, Gemini was rate-limited
// and the mandatory live test call (a live batch submit/poll/fetch-result
// round trip that the migration plan requires before writing this parser)
// couldn't be done. `extractState`/`extractResultFileName` below check
// several plausible field paths defensively so a layout mismatch surfaces as
// a warning + 'pending'/'failed' state rather than a silent misparse, but
// this must still be confirmed against a real API response before this ships.

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
import { insertLlmBatchJob } from '../llm-batch-jobs'

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
 * Builds the JSONL, uploads it, and submits a batchGenerateContent job.
 * Writes the `llm_batch_jobs` row on success. Returns the job's resource name
 * (`batches/...`), or null on any failure — the caller logs and leaves the
 * items unchanged so the next run tries again (no partial/half-submitted state).
 */
export async function submitGeminiBatch(
  items: { key: string; input: LlmInput }[],
  config: LlmConfig,
  source: 'enrich' | 'reprocess',
): Promise<string | null> {
  const lineItems = items
    .map((item) => ({ item, line: buildJsonlLine(item.key, item.input) }))
    .filter((entry): entry is { item: { key: string; input: LlmInput }; line: string } => entry.line != null)
  if (lineItems.length === 0) return null
  const lines = lineItems.map((entry) => entry.line)
  // Google may return file results in input order without echoing the JSONL
  // `key` on every line. Persist an ordinal fallback so the poller can still
  // merge each response into the right extraction-cache entry.
  const customIdMap = Object.fromEntries(lineItems.map((entry, index) => [String(index), entry.item.key]))
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
    const recorded = await insertLlmBatchJob({ jobName, source, itemCount: lines.length, customIdMap })
    if (!recorded) {
      console.warn(`[gemini-batch] failed to record job ${jobName} — treating submission as failed`)
      return null
    }
    return jobName
  } catch (err) {
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
