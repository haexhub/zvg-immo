// Shared plumbing for the four Batch API clients (gemini-batch.ts,
// anthropic-batch.ts, openai-batch.ts, openrouter-batch.ts). Each provider
// still owns its own request/response wire format and
// recordLlmBatchCapability calls — only the generic "what does this ofetch
// error actually say" / "is this failure durable or just transient" / "id
// for this item" plumbing was identical across all of them and lives here
// instead of four near-copies.

import { createHash } from 'node:crypto'
import type { LlmConfig } from './llm'

/** ofetch's FetchError.message is generic ("[POST] "url": 400 Bad Request")
 *  — the actionable text lives in the parsed JSON body ofetch exposes as
 *  `.data`. Handles both the plain `{error:{message}}` shape (OpenAI,
 *  Anthropic, OpenRouter) and Google's `{error:{message,status}}` (status
 *  prefixed onto the message); falls back to the generic message otherwise. */
export function extractOfetchErrorMessage(err: unknown): string {
  const data = (err as { data?: unknown })?.data as { error?: { message?: unknown; status?: unknown } } | undefined
  if (data?.error && typeof data.error.message === 'string') {
    const status = typeof data.error.status === 'string' ? `${data.error.status}: ` : ''
    return `${status}${data.error.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

/** Timeouts, connection failures and 5xx/429 responses say nothing about
 *  whether this account/model can batch at all — only a durable rejection
 *  should ever flip a provider's recorded capability to broken, or a
 *  transient blip could disable batching for every subsequent run until
 *  someone notices and manually re-checks it. gemini-batch.ts intercepts its
 *  own 429s earlier via isGeminiQuotaError (for a day-long backoff instead of
 *  a capability flip), so this function seeing a 429 there is unreachable in
 *  practice, not a behavior change from the version it used to keep locally. */
export function isTransientBatchError(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } })?.status
  const statusCode =
    typeof status === 'number' ? status : (err as { statusCode?: unknown })?.statusCode
  const responseStatus = (err as { response?: { status?: unknown } })?.response?.status
  const httpStatus = typeof statusCode === 'number' ? statusCode : typeof responseStatus === 'number' ? responseStatus : undefined
  if (httpStatus != null && (httpStatus === 429 || httpStatus >= 500)) return true
  const name = (err as { name?: unknown })?.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code
  return typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(code)
}

/** Deterministic per-item request id, used by the file/inline-request batch
 *  formats (OpenAI, Anthropic, OpenRouter) to map a result line back to the
 *  original auction key via each job's customIdMap. gemini-batch.ts doesn't
 *  use this — it keys results by their ordinal position in the JSONL file
 *  instead (see its customIdMap comment). */
export function customIdForKey(key: string, index: number): string {
  const hash = createHash('sha256').update(key).digest('base64url').slice(0, 18)
  return `zvg_${index}_${hash}`.slice(0, 64)
}

export function apiBase(config: LlmConfig): string {
  return config.baseUrl.replace(/\/$/, '')
}

/** Per-item error text for the OpenAI/OpenRouter-style batch result line
 *  shape (`{error, response:{status_code, body}}`) — used when one item
 *  within an otherwise-successful job failed. Checked in order: an explicit
 *  top-level `error.message`, then a non-200 response body's own
 *  `error.message`, then a bare HTTP status as a last resort. Feeds
 *  llm-batch-poll.ts's task_run_errors write, which is why a batch-path
 *  failure used to show up in /settings' LLM-status card with no message at
 *  all (see llm-batch-poll.ts's header). */
export function extractBatchItemErrorMessage(
  error: unknown,
  response: { status_code?: unknown; body?: unknown } | null | undefined,
): string | null {
  const topError = error as { message?: unknown } | undefined
  if (typeof topError?.message === 'string') return topError.message
  const status = response?.status_code
  if (typeof status === 'number' && status !== 200) {
    const body = response?.body as { error?: { message?: unknown } } | undefined
    if (typeof body?.error?.message === 'string') return body.error.message
    return `HTTP ${status}`
  }
  return null
}
