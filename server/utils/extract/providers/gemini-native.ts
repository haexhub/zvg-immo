// Speaks Gemini's own native API (not the OpenAI-compat layer used by
// OpenAiCompatibleProvider) for its one genuine extra capability: native PDF
// understanding. `document` parts carry raw PDF bytes straight through as
// `inlineData` — the bake-off finding this provider exists to preserve is
// that Gemini reads scanned Gutachten correctly without a rasterize/OCR step.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig } from '../llm'
import { isDailyQuotaError, isRateLimitError, LlmProviderError } from '../llm'
import { toGeminiSchema } from './gemini-schema'

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

export function toGeminiParts(parts: ContentPart[]): GeminiPart[] {
  return parts.map((part) => {
    if (part.type === 'text') return { text: part.text }
    return { inlineData: { mimeType: part.mimeType, data: part.data } }
  })
}

export function parseGeminiExtractionResponse(resp: unknown): Record<string, unknown> | null {
  if (!resp || typeof resp !== 'object') return null
  const candidates = (resp as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts
  if (!Array.isArray(parts) || parts.length === 0) return null
  const text = (parts[0] as { text?: unknown })?.text
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Discovered in the WP-0 bake-off: 'gemini-2.5-flash' 404s for newly created
// API keys. Not "nice to have" — the concrete default that actually works.
// Exported so gemini-batch.ts (same provider, batch mode) shares it instead
// of duplicating the string.
export const DEFAULT_MODEL = 'gemini-flash-latest'

// The free tier hard-caps gemini-flash-latest at ~5 requests/minute (bake-off
// finding) — enrich/reprocess's concurrent workers (ENRICH_CONCURRENCY=8, up
// to maxLlmPerRun calls) otherwise fire far more than that within seconds and
// get 429'd wholesale (observed in prod: 202/202 calls failed in ~90s). Same
// pacing pattern as server/utils/geocode.ts: serialize request starts across
// all concurrent callers through a shared queue, spaced MIN_REQUEST_GAP_MS
// apart, process-wide (not per-item) since the limit is per API key, not per
// call site. Padded slightly above the exact 12000ms/5rpm to cover clock drift.
const MIN_REQUEST_GAP_MS = 12_500
const MAX_RETRIES = 3
let lastRequestAt = 0
let queue: Promise<void> = Promise.resolve()

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Blocks until at least MIN_REQUEST_GAP_MS has passed since the last call
 *  across ALL concurrent callers (queue serialises the wait-then-stamp dance,
 *  same as geocode.ts). Retries reuse this too, so a 429 is paced the same as
 *  a fresh request instead of stacking an extra backoff on top. */
async function paceNextRequest(): Promise<void> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
  })
  queue = run.catch(() => {})
  await run
}

export class GeminiNativeProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  async extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void },
  ): Promise<Record<string, unknown> | null> {
    const model = this.config.model || DEFAULT_MODEL
    const body = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: [{ role: 'user', parts: toGeminiParts(req.parts) }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(req.schema),
        // Same fallback as the other two providers, for consistency —
        // previously missing entirely, so config.maxTokens was silently
        // ignored for this provider (see resolveLlmConfig()'s callers).
        maxOutputTokens: this.config.maxTokens ?? 4096,
      },
    }
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`
    let resp: unknown
    for (let attempt = 0; ; attempt++) {
      await paceNextRequest()
      try {
        // Same rationale as the other providers: bound the request so a stuck
        // upstream call can't hang the enrich task's Promise.all forever.
        resp = await $fetch(url, {
          method: 'POST',
          // Key goes in a header, not the URL query string — avoids leaking it
          // into server access logs and proxy request logs.
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey ?? '' },
          body,
          signal: AbortSignal.timeout(60_000),
        })
        break
      } catch (err) {
        if (isRateLimitError(err)) {
          // A per-day quota won't clear before midnight Pacific, so retrying
          // it only burns MIN_REQUEST_GAP_MS per attempt. Hand it straight to
          // the caller, which can move on to the next configured model (see
          // isDailyQuotaError()).
          if (isDailyQuotaError(err)) {
            console.warn('[extract/llm] gemini daily quota exhausted, not retrying')
            throw err
          }
          if (attempt < MAX_RETRIES) {
            console.warn(`[extract/llm] gemini 429, retry ${attempt + 1}/${MAX_RETRIES}`)
            continue
          }
          // Retries exhausted on a persistent rate limit — a capacity
          // problem, not evidence this auction/document is bad. Rethrow
          // (see isRateLimitError()) instead of returning null so it isn't
          // counted toward the retry-lockout.
          console.warn(`[extract/llm] gemini 429, giving up after ${MAX_RETRIES} retries`)
          throw err
        }
        // A caller that passes onRequestError (extractByLlm) wants to keep
        // batching past a single failed candidate; one that doesn't (e.g.
        // callSummaryLlm/callTranslationLlm) wants the failure to reject.
        if (!opts?.onRequestError) throw new LlmProviderError('gemini-native', (err as Error).message, { cause: err })
        console.warn(`[extract/llm] request failed: ${(err as Error).message}`)
        opts.onRequestError(err)
        return null
      }
    }
    const parsed = parseGeminiExtractionResponse(resp)
    if (!parsed) throw new LlmProviderError('gemini-native', 'ungültige oder leere Provider-Antwort')
    return parsed
  }
}
