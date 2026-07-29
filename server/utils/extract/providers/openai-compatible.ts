// Generic provider for any backend speaking the OpenAI chat-completions wire
// format (OpenAI itself, Kimi/Moonshot, DeepSeek, Groq, Gemini via its OpenAI-
// compat layer, ...). This is the default extraction path: switching backend
// is a baseUrl/apiKey/model config change, never a new class.

import type { ContentPart, ExtractionProvider, ExtractionRequest, LlmConfig } from '../llm'
import { isRateLimitError, LlmProviderError, UNIVERSAL_AUCTION_SCHEMA_NAME } from '../llm'

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

export class OpenAiCompatibleProvider implements ExtractionProvider {
  constructor(private config: LlmConfig) {}

  async extract(req: ExtractionRequest): Promise<Record<string, unknown> | null> {
    const body = {
      model: this.config.model,
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
    } catch (err) {
      // Rethrow a rate limit/quota error instead of swallowing it to null —
      // see isRateLimitError() — so it isn't counted toward the retry-lockout.
      if (isRateLimitError(err)) throw err
      throw new LlmProviderError('openai-compatible', (err as Error).message, { cause: err })
    }
    const parsed = parseOpenAiExtractionResponse(resp)
    if (!parsed) throw new LlmProviderError('openai-compatible', 'ungültige oder leere Provider-Antwort')
    return parsed
  }
}
