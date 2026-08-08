// LLM fallback extractor. Sends the listing text (title + description +
// optional attachment/document context) to an LLM provider and gets back
// structured fields through a forced-schema tool/response-format call. Used
// for what the deterministic rules can't resolve: sizes buried in PDF prose,
// and property types for non-German sources the property-type classifier misses.
//
// Optionally vision: when `pdfPageImages` is set (a scanned/image-only
// Gutachten PDF where pdftotext returned nothing usable — see
// server/tasks/enrich.ts), the rendered page images are sent alongside the
// prompt instead of relying on text alone. parseExtractionResponse/
// clampExtraction are pure and unit-tested; the network call is a thin wrapper.

import { ClaudeProxyProvider } from './providers/claude-proxy'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'
import { GeminiNativeProvider } from './providers/gemini-native'
import { clampExtraction, type ClampedExtraction } from './llm-clamp'
import {
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  UNIVERSAL_AUCTION_SCHEMA_ID,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
  UNIVERSAL_AUCTION_SCHEMA_VERSION,
} from './llm-schema'

export {
  clampExtraction,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  UNIVERSAL_AUCTION_SCHEMA_ID,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
  UNIVERSAL_AUCTION_SCHEMA_VERSION,
}
export type { ClampedExtraction, PhotoCuration } from './llm-clamp'

export interface LlmInput {
  title: string | null
  description: string | null
  /** Extracted prose from non-PDF documents (HTML, DOCX, text) plus any
   *  unsupported attachment notices. PDF prose remains in pdfText so the
   *  native-document providers can intentionally omit it when raw PDFs are
   *  supplied instead. */
  documentText?: string | null
  pdfText?: string | null
  /** Base64 JPEGs of Gutachten pages 1..N, used when pdfText is too sparse to
   *  be the scanned PDF's real content (see pdfPagesToBase64Jpeg). Page 1
   *  alone isn't enough — it's almost always a cover page, the facts sought
   *  are on later pages. */
  pdfPageImages?: string[] | null
  /** Raw PDF bytes (base64) for providers with native document understanding
   *  (GeminiNativeProvider) — reads scans correctly without a rasterize/OCR
   *  step. Providers that don't support it ignore this field and fall back
   *  to pdfText/pdfPageImages instead. */
  pdfBytes?: string | null
  /** Multiple listing-specific PDFs for native document-understanding
   * providers. Labels keep appraisal, brochure and announcement distinguishable
   * to the model. */
  pdfDocuments?: { label: string; data: string }[]
  /** Base64 images that are documents in their own right (e.g. scanned JPG/PNG
   *  attachments), not merely photos offered for gallery curation. */
  documentImages?: { label: string; mimeType: string; data: string }[]
  /** Candidate photos for LLM-driven curation. Referenced by index
   *  (`photoIndex`) in the extraction response rather than by filename,
   *  since a filename echoed back by the model is unreliable. */
  candidateImages?: { label: string; mimeType: string; data: string }[]
}

export interface LlmConfig {
  /** Which backend sends the extraction request. Default 'openai-compatible'
   *  — most providers (OpenAI, Kimi/Moonshot, DeepSeek, Groq, Gemini-via-
   *  compat-layer) speak the same OpenAI chat-completions wire format, so
   *  switching between them is a baseUrl/apiKey/model config change, not a
   *  code change. 'claude-proxy' is the transitional Anthropic-format path.
   *  'gemini-native' opts into Gemini's own API instead of its OpenAI-compat
   *  layer, for its one genuine extra capability: native PDF understanding
   *  (see `document` ContentPart below). */
  provider?: 'claude-proxy' | 'openai-compatible' | 'gemini-native' | 'openrouter'
  baseUrl: string
  apiKey?: string
  model: string
  maxTokens?: number
}

export class LlmProviderError extends Error {
  readonly provider: string

  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(`${provider}: ${message}`, options)
    this.name = 'LlmProviderError'
    this.provider = provider
  }
}

export function isLlmProviderError(error: unknown): error is LlmProviderError {
  return error instanceof LlmProviderError
}

/** Provider-neutral request content — a specific backend's provider
 *  implementation translates this into its own wire format (e.g. Claude's
 *  content blocks, OpenAI's `image_url`, Gemini's `inlineData`).
 *  `document` carries raw PDF bytes; only a provider with native document
 *  understanding honors it, all others ignore that part type and rely on
 *  `pdfText`/`pdfPageImages` parts instead. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'document'; mimeType: 'application/pdf'; data: string }

export interface ExtractionRequest {
  systemPrompt: string
  schema: Record<string, unknown>
  parts: ContentPart[]
}

/** Narrow seam between prompt/schema building (provider-agnostic) and the
 *  wire format a specific backend expects. Swapping or adding a provider
 *  means writing a new implementation of this interface, not touching
 *  buildParts/clampExtraction. Implementations resolve to null for a request
 *  failure or unparseable response, but must throw (not swallow to null) when
 *  the failure is a rate limit/quota error — see isRateLimitError(). `opts.
 *  onRequestError` fires only for an actual request failure (network/HTTP
 *  error), never for an empty/unparseable response — reprocess.ts uses it to
 *  tell "the provider errored" apart from "the provider returned nothing",
 *  which extractByLlm's null return can't distinguish on its own. */
export interface ExtractionProvider {
  extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void },
  ): Promise<Record<string, unknown> | null>
}

/** Whether a thrown $fetch error was an HTTP 429 (rate limit/quota exceeded).
 *  Providers rethrow rather than swallow this to null so a capacity outage
 *  (observed in prod on Gemini's free tier — see gemini-native.ts) never
 *  counts toward extraction's retry-lockout: reprocess.ts's per-candidate
 *  try/catch skips a thrown error without touching the cache entry, leaving
 *  `llmFailures` untouched so the auction is retried again next run instead
 *  of being permanently downgraded to rules-only after MAX_LLM_FAILURES
 *  unrelated capacity failures. */
export function isRateLimitError(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 429
}

/** Every `quotaId` Google attached to a QuotaFailure detail in the error body
 *  (e.g. 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'). Empty for
 *  providers that don't report quota details. */
function quotaIds(err: unknown): string[] {
  const details = (err as { data?: { error?: { details?: unknown } } })?.data?.error?.details
  if (!Array.isArray(details)) return []
  const ids: string[] = []
  for (const detail of details) {
    const violations = (detail as { violations?: unknown })?.violations
    if (!Array.isArray(violations)) continue
    for (const violation of violations) {
      const id = (violation as { quotaId?: unknown })?.quotaId
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/**
 * Whether a 429 is a *per-day* quota rather than a per-minute rate limit.
 * The distinction decides whether waiting can help at all: a per-minute limit
 * clears in seconds, a daily one only at midnight Pacific. Retrying the
 * latter burns MAX_RETRIES × MIN_REQUEST_GAP_MS (~50 s) per candidate for
 * nothing — measured in prod on 2026-07-31, where it cut reprocess throughput
 * from ~300 to ~58 auctions per hourly run.
 *
 * Deliberately conservative: only true when the provider actually says so via
 * a `quotaId` containing 'PerDay'. Providers that report no quota details keep
 * their previous retry behaviour rather than being guessed at.
 */
export function isDailyQuotaError(err: unknown): boolean {
  return isRateLimitError(err) && quotaIds(err).some((id) => /perday/i.test(id))
}

/** Whether the current model/profile is the problem — rate-limited/over
 *  quota, or a provider-level failure such as a model id that no longer
 *  resolves (see gemini-native.ts) — as opposed to a caller-side bug. Callers
 *  configured with a fallback chain (see app-settings.ts's
 *  getLlmProviderOverrideChain) use this to decide whether to try the next
 *  model instead of giving up. */
export function isLlmProviderUnavailable(err: unknown): boolean {
  return isRateLimitError(err) || isLlmProviderError(err)
}

const MAX_PDF_CHARS = 60_000
const MAX_DOCUMENT_TEXT_CHARS = 80_000

/** Pull the structured object out of the proxy's `final_result` tool_use block. */
export function parseExtractionResponse(resp: unknown): Record<string, unknown> | null {
  if (!resp || typeof resp !== 'object') return null
  const content = (resp as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const block = content.find(
    (c): c is { input: unknown } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'tool_use' &&
      (c as { name?: unknown }).name === 'final_result',
  )
  if (!block || typeof block.input !== 'object' || block.input == null) return null
  return block.input as Record<string, unknown>
}

/**
 * Assemble provider-neutral content parts from an LlmInput. When `pdfBytes`
 * is set (a provider with native document understanding is in play),
 * `pdfText`/`pdfPageImages` are left out — sending both would double the
 * token cost for the same information.
 */
export function buildParts(input: LlmInput): ContentPart[] {
  const text: string[] = []
  if (input.title) text.push(`Objektbezeichnung: ${input.title}`)
  if (input.description) text.push(`Beschreibung:\n${input.description}`)
  if (input.documentText) {
    text.push(`Weitere Dokumenttexte/HTML-Anhänge:\n${input.documentText.slice(0, MAX_DOCUMENT_TEXT_CHARS)}`)
  }
  const nativeDocuments = input.pdfDocuments?.length
    ? input.pdfDocuments
    : input.pdfBytes
      ? [{ label: 'Gutachten/Exposé', data: input.pdfBytes }]
      : []
  const usingDocumentPart = nativeDocuments.length > 0
  if (input.pdfText && !usingDocumentPart) {
    text.push(`Auszug aus Gutachten/Exposé (PDF):\n${input.pdfText.slice(0, MAX_PDF_CHARS)}`)
  }
  if (input.pdfPageImages?.length && !usingDocumentPart) {
    text.push(
      'Das Gutachten/Exposé liegt als eingescanntes Bild vor (siehe angehängte Bilder) — lies die Eckdaten daraus ab.',
    )
  }
  if (input.documentImages?.length) {
    text.push(
      `Es folgen ${input.documentImages.length} Bildanhänge/Dokumentbilder. Lies auch daraus Objektangaben, ` +
        'Scans, Pläne, Tabellen und erkennbare Widersprüche ab.',
    )
  }
  if (input.candidateImages?.length) {
    text.push(
      `Es folgen ${input.candidateImages.length} Kandidatenbilder aus dem Dokument, jeweils mit ` +
        'vorangestelltem "Bild N:"-Label. Kuratiere jedes Bild im photos-Array (siehe Schema).',
    )
  }

  const parts: ContentPart[] = []
  if (text.length) parts.push({ type: 'text', text: text.join('\n\n') })
  if (usingDocumentPart) {
    for (const document of nativeDocuments) {
      if (nativeDocuments.length > 1) {
        parts.push({ type: 'text', text: `Dokument: ${document.label}` })
      }
      parts.push({ type: 'document', mimeType: 'application/pdf', data: document.data })
    }
  } else if (input.pdfPageImages?.length) {
    for (const data of input.pdfPageImages) parts.push({ type: 'image', mimeType: 'image/jpeg', data })
  }
  if (input.documentImages?.length) {
    for (const image of input.documentImages) {
      parts.push({ type: 'text', text: `Dokumentbild: ${image.label}` })
      parts.push({ type: 'image', mimeType: image.mimeType, data: image.data })
    }
  }
  if (input.candidateImages?.length) {
    input.candidateImages.forEach((img, i) => {
      parts.push({ type: 'text', text: `Bild ${i}: ${img.label}` })
      parts.push({ type: 'image', mimeType: img.mimeType, data: img.data })
    })
  }
  return parts
}

/** The provider switch that every caller of extractByLlm/text-llm.ts goes
 *  through — the one place a new backend gets wired in. */
export function getProvider(config: LlmConfig): ExtractionProvider {
  switch (config.provider ?? 'openai-compatible') {
    case 'claude-proxy':
      return new ClaudeProxyProvider(config)
    case 'openai-compatible':
    case 'openrouter':
      return new OpenAiCompatibleProvider(config)
    case 'gemini-native':
      return new GeminiNativeProvider(config)
    default:
      throw new Error(`Unknown extraction provider: ${config.provider}`)
  }
}

/** Build an LlmConfig from the extractLlm runtime-config shape shared by
 *  enrich.ts/reprocess.ts and the on-demand summary/translation endpoints.
 *  Returns null when unconfigured (baseUrl unset) — same graceful-degrade
 *  contract as those callers. */
export function resolveLlmConfig(
  c: { provider?: string; baseUrl?: string; apiKey?: string; model?: string } | undefined,
  overrides?: { maxTokens?: number },
): LlmConfig | null {
  if (!c?.baseUrl) return null
  const provider =
    c.provider === 'claude-proxy' || c.provider === 'gemini-native' || c.provider === 'openrouter'
      ? c.provider
      : 'openai-compatible'
  return {
    provider,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey || undefined,
    model: c.model || (provider === 'gemini-native' ? 'gemini-flash-latest' : 'claude-haiku-4-5'),
    maxTokens: overrides?.maxTokens,
  }
}

/** Returns null on empty input, request failure, or unparseable response.
 *  Throws instead when the provider hit a rate limit/quota error — see
 *  isRateLimitError(); left unhandled so it reaches reprocess.ts's per-
 *  candidate catch, which skips the attempt without counting a failure.
 *  `onProviderError` (see ExtractionProvider) only fires for a genuine
 *  request failure, not for parts.length === 0 (no attempt was made) or an
 *  empty/unparseable response. */
export async function extractByLlm(
  input: LlmInput,
  config: LlmConfig,
  opts: { onProviderAttempt?: () => void; onProviderError?: (err: unknown) => void } = {},
): Promise<ClampedExtraction | null> {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  opts.onProviderAttempt?.()
  const raw = await getProvider(config).extract(
    { systemPrompt: SYSTEM_PROMPT, schema: UNIVERSAL_AUCTION_SCHEMA, parts },
    { onRequestError: opts.onProviderError },
  )
  return raw ? clampExtraction(raw) : null
}
