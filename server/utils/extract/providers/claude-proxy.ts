// Sends extraction requests through haex-claude-proxy's Anthropic-compatible
// `/v1/messages` endpoint, using a forced tool call to get JSON back.
// Transitional provider (Anthropic-Messages-Format, not OpenAI-compatible)
// until the Claude path is retired in favor of OpenAiCompatibleProvider/
// GeminiNativeProvider.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig } from '../llm'
import { isRateLimitError, LlmProviderError, parseExtractionResponse, TRANSIENT_RETRY_DELAYS_MS } from '../llm'

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

export class ClaudeProxyProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  async extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void },
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
        // the whole run. 120s (not 60s): observed in prod, the subprocess itself
        // can take 80s+ to exit even on success, so 60s aborted a call that would
        // otherwise have succeeded moments later.
        resp = await $fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
          },
          body,
          signal: AbortSignal.timeout(120_000),
        })
        break
      } catch (err) {
        // Rethrow a rate limit/quota error instead of swallowing it to null —
        // see isRateLimitError() — so it isn't counted toward the retry-lockout.
        if (isRateLimitError(err)) throw err
        // A transient failure (e.g. OpenRouter's thin-provider-pool 404, "no
        // endpoint available right now") gets a couple of quick retries on
        // the same model before giving up — see TRANSIENT_RETRY_DELAYS_MS.
        if (attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          console.warn(
            `[extract/llm] request failed, retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length}: ${(err as Error).message}`,
          )
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]))
          continue
        }
        // A caller that passes onRequestError (extractByLlm) wants to keep
        // batching past a single failed candidate; one that doesn't (e.g.
        // callSummaryLlm/callTranslationLlm) wants the failure to reject.
        if (!opts?.onRequestError) throw new LlmProviderError('claude-proxy', (err as Error).message, { cause: err })
        console.warn(`[extract/llm] request failed: ${(err as Error).message}`)
        opts.onRequestError(err)
        return null
      }
    }
    const parsed = parseExtractionResponse(resp)
    if (!parsed) throw new LlmProviderError('claude-proxy', 'ungültige oder leere Provider-Antwort')
    return parsed
  }
}
