// Speaks Gemini's own native API (not the OpenAI-compat layer used by
// OpenAiCompatibleProvider) for its one genuine extra capability: native PDF
// understanding. `document` parts carry raw PDF bytes straight through as
// `inlineData` — the bake-off finding this provider exists to preserve is
// that Gemini reads scanned Gutachten correctly without a rasterize/OCR step.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig } from '../llm'
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

  async extract(req: ExtractionRequest): Promise<Record<string, unknown> | null> {
    const model = this.config.model || DEFAULT_MODEL
    const body = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: [{ role: 'user', parts: toGeminiParts(req.parts) }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(req.schema),
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
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 429 && attempt < MAX_RETRIES) {
          console.warn(`[extract/llm] gemini 429, retry ${attempt + 1}/${MAX_RETRIES}`)
          continue
        }
        console.warn(`[extract/llm] request failed: ${(err as Error).message}`)
        return null
      }
    }
    return parseGeminiExtractionResponse(resp)
  }
}
