// Generic provider for any backend speaking the OpenAI chat-completions wire
// format (OpenAI itself, Kimi/Moonshot, DeepSeek, Groq, Gemini via its OpenAI-
// compat layer, ...). This is the default extraction path: switching backend
// is a baseUrl/apiKey/model config change, never a new class.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig, LlmUsage } from '../llm'
import {
  isRateLimitError,
  isTransientRequestError,
  LlmProviderError,
  TRANSIENT_RETRY_DELAYS_MS,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
} from '../llm'

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** `document` parts (raw PDF bytes) are dropped here — no OpenAI-compatible
 *  backend accepts inline PDF bytes over this wire format — so callers on
 *  this provider rely on the `pdfText`/`pdfPageImages` parts buildParts
 *  already produced instead (see ../llm.ts). */
export function toOpenAiContent(parts: ContentPart[]): OpenAiContentPart[] {
  const content: OpenAiContentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text })
    else if (part.type === 'image') {
      content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } })
    }
  }
  return content
}

/** Reads the OpenAI-compatible `usage.{prompt_tokens,completion_tokens}`
 *  block. Every field is optional/absent on some backends, so each is read
 *  independently rather than requiring the whole object. */
export function parseOpenAiUsage(resp: unknown): LlmUsage {
  const usage = (resp as { usage?: unknown })?.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined
  const inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null
  const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null
  return { inputTokens, outputTokens }
}

/** Pull the structured object out of the first choice's message content,
 *  which `response_format: json_schema` guarantees is a JSON-serialized
 *  string matching `req.schema`. */
export function parseOpenAiExtractionResponse(resp: unknown): Record<string, unknown> | null {
  if (!resp || typeof resp !== 'object') return null
  const choices = (resp as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  if (typeof content !== 'string' || !content.trim()) return null
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** ofetch's default error message is just the HTTP status line ("403
 *  Forbidden") — the actual reason (e.g. OpenRouter's "input flagged by
 *  moderation" explanation for a 403) lives in the JSON error body ofetch
 *  also attaches to the thrown error as `.data`. Append it when present so
 *  callers/logs don't have to reproduce the request against the provider to
 *  find out why. */
function describeRequestError(err: unknown): string {
  const base = (err as Error).message
  const detail = (err as { data?: { error?: { message?: unknown } } })?.data?.error?.message
  return typeof detail === 'string' && detail.trim() ? `${base} — ${detail}` : base
}

export class OpenAiCompatibleProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  private get providerLabel(): string {
    return this.config.provider ?? 'openai-compatible'
  }

  /** OpenRouter lists `:batch`-suffixed ids (e.g. `google/gemini-3.5-flash-lite:batch`)
   *  as separate, cheaper catalog entries for its Batch API (see
   *  openrouter-batch.ts, which sends the suffix as-is to POST /batches) —
   *  but that suffix 404s unconditionally on /chat/completions. Auctions with
   *  photos/PDFs bypass the batch queue and land here synchronously (see
   *  batchSupportsMultimodal in ../llm-batch.ts), as does every non-extraction
   *  use case (translation), so a profile deliberately configured with a
   *  `:batch` model for its cost savings must still work on this path. */
  private get syncModel(): string {
    return this.config.provider === 'openrouter' ? this.config.model.replace(/:batch$/, '') : this.config.model
  }

  async extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void; onUsage?: (usage: LlmUsage) => void },
  ): Promise<Record<string, unknown> | null> {
    const body = {
      model: this.syncModel,
      // Raised from 512: the response now also carries `insights` (up to two
      // 20-item string lists plus free text) and a per-candidate-photo
      // curation array — the old budget truncated the larger JSON payload.
      max_tokens: this.config.maxTokens ?? 4096,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: toOpenAiContent(req.parts) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: UNIVERSAL_AUCTION_SCHEMA_NAME, schema: req.schema, strict: true },
      },
    }
    let resp: unknown
    for (let attempt = 0; ; attempt++) {
      try {
        // Same rationale as ClaudeProxyProvider: bound the request so a stuck
        // upstream call can't hang the enrich task's Promise.all forever.
        resp = await $fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(60_000),
        })
        break
      } catch (err) {
        // Rethrow a rate limit/quota error instead of swallowing it to null —
        // see isRateLimitError() — so it isn't counted toward the retry-lockout.
        if (isRateLimitError(err)) throw err
        // A transient failure (e.g. OpenRouter's thin-provider-pool 404, "no
        // endpoint available right now") gets a couple of quick retries on
        // the same model before giving up — see TRANSIENT_RETRY_DELAYS_MS. A
        // 400/401/403 will fail identically every time, so skip straight to
        // giving up instead of paying the retry delay for nothing.
        if (isTransientRequestError(err) && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          console.warn(
            `[extract/llm] request failed, retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}: ${describeRequestError(err)}`,
          )
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]))
          continue
        }
        // A caller that passes onRequestError (extractByLlm) wants to keep
        // batching past a single failed candidate; one that doesn't (e.g.
        // callSummaryLlm/callTranslationLlm) wants the failure to reject.
        if (!opts?.onRequestError) throw new LlmProviderError(this.providerLabel, describeRequestError(err), { cause: err })
        console.warn(`[extract/llm] request failed: ${describeRequestError(err)}`)
        opts.onRequestError(err)
        return null
      }
    }
    opts?.onUsage?.(parseOpenAiUsage(resp))
    const parsed = parseOpenAiExtractionResponse(resp)
    if (!parsed) throw new LlmProviderError(this.providerLabel, 'ungültige oder leere Provider-Antwort')
    return parsed
  }
}
