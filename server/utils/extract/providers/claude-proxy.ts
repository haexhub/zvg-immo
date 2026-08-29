// Sends extraction requests through haex-claude-proxy's Anthropic-compatible
// `/v1/messages` endpoint, using a forced tool call to get JSON back.
// Transitional provider (Anthropic-Messages-Format, not OpenAI-compatible)
// until the Claude path is retired in favor of OpenAiCompatibleProvider/
// GeminiNativeProvider.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig, LlmUsage } from '../llm'
import {
  isRateLimitError,
  isTransientRequestError,
  LlmProviderError,
  parseExtractionResponse,
  TRANSIENT_RETRY_DELAYS_MS,
} from '../llm'

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** This proxy path forwards only text and image blocks: `document` parts are
 *  intentionally dropped here — the transitional proxy doesn't relay native
 *  PDF documents — so callers on this provider rely on the `pdfText`/
 *  `pdfPageImages` parts buildParts already produced instead (see ../llm.ts). */
function toClaudeContent(parts: ContentPart[]): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } })
    }
  }
  return blocks
}

/** Reads the Anthropic Messages API's `usage.{input_tokens,output_tokens}`. */
export function parseClaudeUsage(resp: unknown): LlmUsage {
  const usage = (resp as { usage?: unknown })?.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : null
  return { inputTokens, outputTokens }
}

export class ClaudeProxyProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  async extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void; onUsage?: (usage: LlmUsage) => void },
  ): Promise<Record<string, unknown> | null> {
    const body = {
      model: this.config.model,
      // Raised from 512: the response now also carries `insights` (up to two
      // 20-item string lists plus free text) and a per-candidate-photo
      // curation array — the old budget truncated the larger JSON payload.
      max_tokens: this.config.maxTokens ?? 4096,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: toClaudeContent(req.parts) }],
      tools: [
        {
          name: 'final_result',
          description: 'Gib die extrahierten Eckdaten im universellen Auktions-JSON zurück.',
          input_schema: req.schema,
        },
      ],
      tool_choice: { type: 'tool', name: 'final_result' },
    }
    let resp: unknown
    for (let attempt = 0; ; attempt++) {
      try {
        // Bound the request: the proxy spawns a `claude` subprocess per call, so a
        // stuck spawn (or upstream stall) would keep this promise pending forever
        // and — because the enrich task awaits every worker via Promise.all — block
        // the whole run. Raised 120s → 240s: prod logs (2026-08-12) showed the
        // subprocess now routinely taking 127-138s to exit even on success — the
        // same failure mode as the original 60s→120s bump, just recurred at the
        // next ceiling as the model/schema grew. Every single sync extraction
        // call was timing out and burning both retries for nothing.
        resp = await $fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
          },
          body,
          signal: AbortSignal.timeout(240_000),
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
        // A reprocess call passes onRequestError.  Its prompts can include
        // multiple rendered document pages and are consequently expensive on
        // the Claude subscription. Retrying a proxy 5xx/timeout immediately
        // has repeatedly spent the same input budget three times without a
        // usable result. Surface that first failure to reprocess instead: it
        // aborts the run (or tries a configured fallback) without increasing
        // every auction's llm_failures counter. Lightweight callers that do
        // not pass the callback retain the short transient retry behaviour.
        if (!opts?.onRequestError && isTransientRequestError(err) && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          console.warn(
            `[extract/llm] request failed, retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}: ${(err as Error).message}`,
          )
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]))
          continue
        }
        // `onRequestError` is observability, not permission to turn a
        // provider outage into a per-auction extraction failure.  Always
        // reject after reporting it so reprocess can stop safely.
        opts?.onRequestError?.(err)
        throw new LlmProviderError('claude-proxy', (err as Error).message, { cause: err })
      }
    }
    opts?.onUsage?.(parseClaudeUsage(resp))
    const parsed = parseExtractionResponse(resp)
    if (!parsed) throw new LlmProviderError('claude-proxy', 'ungültige oder leere Provider-Antwort')
    return parsed
  }
}
