// Speaks Gemini's own native API (not the OpenAI-compat layer used by
// OpenAiCompatibleProvider) for its one genuine extra capability: native PDF
// understanding. `document` parts carry raw PDF bytes straight through as
// `inlineData` — the bake-off finding this provider exists to preserve is
// that Gemini reads scanned Gutachten correctly without a rasterize/OCR step.

import { createHash } from 'node:crypto'
import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig, LlmUsage } from '../llm'
import { isDailyQuotaError, isRateLimitError, isTransientRequestError, LlmProviderError, TRANSIENT_RETRY_DELAYS_MS } from '../llm'
import { toGeminiSchema } from './gemini-schema'

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

export function toGeminiParts(parts: ContentPart[]): GeminiPart[] {
  return parts.map((part) => {
    if (part.type === 'text') return { text: part.text }
    return { inlineData: { mimeType: part.mimeType, data: part.data } }
  })
}

/** Reads `usageMetadata.{promptTokenCount,candidatesTokenCount}` — the same
 *  field recordTokenUsage() below already reads for TPM pacing, exposed here
 *  for cost accounting too. */
export function parseGeminiUsage(resp: unknown): LlmUsage {
  const usage = (resp as { usageMetadata?: unknown })?.usageMetadata as
    | { promptTokenCount?: unknown; candidatesTokenCount?: unknown }
    | undefined
  const inputTokens = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : null
  const outputTokens = typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : null
  return { inputTokens, outputTokens }
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
// pacing pattern as server/utils/geocode.ts: serialize request starts through
// a shared queue, spaced MIN_REQUEST_GAP_MS apart. Padded slightly above the
// exact 12000ms/5rpm to cover clock drift.
const MIN_REQUEST_GAP_MS = 12_500
const MAX_RETRIES = 3

// GenerateContentInputTokensPerModelPerMinute-FreeTier caps gemini flash-lite
// at 250k tokens/minute per key — measured 2026-08-01 against a key sitting at
// a comfortable 6/15 on requests/minute while already at 298.92k/250k on
// tokens. The MIN_REQUEST_GAP_MS gate above never sees that: it counts
// requests, not the size of the Gutachten PDFs inlined into them, so a
// handful of large documents blow the token quota well before the request
// quota notices anything wrong.
const TPM_CAP = 250_000
const TOKEN_WINDOW_MS = 60_000

type PaceGate = {
  lastRequestAt: number
  queue: Promise<void>
  /** Actual tokens (from each response's own usageMetadata) spent by this
   *  bucket in roughly the trailing minute — not estimated, since there's no
   *  cheap way to know an inlineData PDF's token cost before sending it. */
  tokenWindow: { at: number; tokens: number }[]
}

/** One pacing gate per quota bucket rather than one process-wide gate. The
 *  429s name their own scope: `GenerateRequestsPerMinutePerProjectPerModel-
 *  FreeTier` (measured against the live API 2026-07-31), i.e. the limit is per
 *  API key — which identifies the Google project — *and* per model. A single
 *  shared gate therefore throttled unrelated keys against each other: with
 *  four keys from four projects assigned to the extraction chain, throughput
 *  stayed at one request per 12.5s instead of four. Keyed by apiKey+model so
 *  the gate granularity matches the quota exactly. */
const paceGates = new Map<string, PaceGate>()

function getGate(bucket: string): PaceGate {
  const gate = paceGates.get(bucket) ?? { lastRequestAt: 0, queue: Promise.resolve(), tokenWindow: [] }
  paceGates.set(bucket, gate)
  return gate
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Drops entries older than TOKEN_WINDOW_MS and returns the remaining sum. */
function prunedTokenSum(gate: PaceGate, now: number): number {
  gate.tokenWindow = gate.tokenWindow.filter((entry) => entry.at > now - TOKEN_WINDOW_MS)
  return gate.tokenWindow.reduce((sum, entry) => sum + entry.tokens, 0)
}

/** Blocks until the bucket's trailing-minute token usage is back under
 *  TPM_CAP. Only engages once the window is actually over budget, so it never
 *  delays a bucket that hasn't hit it yet — the first oversized request in a
 *  window still goes through, and this is what makes the next one wait. */
async function waitForTokenBudget(gate: PaceGate): Promise<void> {
  for (;;) {
    const now = Date.now()
    if (prunedTokenSum(gate, now) < TPM_CAP) return
    const oldest = gate.tokenWindow[0]!
    await sleep(oldest.at + TOKEN_WINDOW_MS - now)
  }
}

function recordTokenUsage(bucket: string, resp: unknown): void {
  // The quota (GenerateContentInputTokensPerModelPerMinute-FreeTier) is scoped
  // to input tokens — promptTokenCount, not totalTokenCount, which also folds
  // in generated output tokens and would overcount against this specific cap.
  const tokens = (resp as { usageMetadata?: { promptTokenCount?: unknown } })?.usageMetadata?.promptTokenCount
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return
  getGate(bucket).tokenWindow.push({ at: Date.now(), tokens })
}

/** Blocks until at least MIN_REQUEST_GAP_MS has passed since the last call
 *  against the same quota bucket, across ALL concurrent callers (queue
 *  serialises the wait-then-stamp dance, same as geocode.ts), and until the
 *  bucket's trailing-minute token usage is back under TPM_CAP. Retries reuse
 *  this too, so a 429 is paced the same as a fresh request instead of stacking
 *  an extra backoff on top. */
async function paceNextRequest(bucket: string): Promise<void> {
  const gate = getGate(bucket)
  const run = gate.queue.then(async () => {
    const wait = gate.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    await waitForTokenBudget(gate)
    gate.lastRequestAt = Date.now()
  })
  gate.queue = run.catch(() => {})
  await run
}

export class GeminiNativeProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  async extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void; onUsage?: (usage: LlmUsage) => void },
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
    // The key is what the quota is scoped to, but it must not be held in a
    // long-lived Map — hash it so paceGates never retains a plaintext secret.
    const bucket = `${createHash('sha256').update(this.config.apiKey ?? '').digest('hex')}|${model}`
    let resp: unknown
    for (let attempt = 0; ; attempt++) {
      await paceNextRequest(bucket)
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
        recordTokenUsage(bucket, resp)
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
        // A transient failure (e.g. OpenRouter/upstream 404s, 5xx, timeouts)
        // gets the same couple of retries as the other providers — see
        // TRANSIENT_RETRY_DELAYS_MS in ../llm.ts — reusing this loop's own
        // pacing (above) instead of a separate backoff. A 400/401/403 will
        // fail identically every time, so skip straight to giving up.
        if (isTransientRequestError(err) && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          console.warn(
            `[extract/llm] request failed, retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}: ${(err as Error).message}`,
          )
          continue
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
    opts?.onUsage?.(parseGeminiUsage(resp))
    const parsed = parseGeminiExtractionResponse(resp)
    if (!parsed) throw new LlmProviderError('gemini-native', 'ungültige oder leere Provider-Antwort')
    return parsed
  }
}
