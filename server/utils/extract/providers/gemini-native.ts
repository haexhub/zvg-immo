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
const DEFAULT_MODEL = 'gemini-flash-latest'

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
    let resp: unknown
    try {
      // Same rationale as the other providers: bound the request so a stuck
      // upstream call can't hang the enrich task's Promise.all forever.
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`
      resp = await $fetch(url, {
        method: 'POST',
        // Key goes in a header, not the URL query string — avoids leaking it
        // into server access logs and proxy request logs.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey ?? '' },
        body,
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      console.warn(`[extract/llm] request failed: ${(err as Error).message}`)
      return null
    }
    return parseGeminiExtractionResponse(resp)
  }
}
