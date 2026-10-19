// LLM fallback extractor. Sends the listing text (title + description +
// optional attachment/document context) to an LLM provider and gets back
// structured fields through a forced-schema tool/response-format call. Used
// for what the deterministic rules can't resolve: sizes buried in PDF prose,
// and property types for non-German sources the property-type classifier misses.
//
// Optionally vision: when `pdfPageImages` is set (a scanned/image-only
// Gutachten PDF where pdftotext returned nothing usable — see
// llm-documents.ts), the rendered page images are sent alongside the prompt
// instead of relying on text alone. clampExtraction is pure and unit-tested;
// the network call is a thin wrapper around the provider implementations.

import { ClaudeProxyProvider } from './providers/claude-proxy'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'
import { GeminiNativeProvider } from './providers/gemini-native'
import { clampExtraction, type ClampedExtraction, type RulesHint } from './llm-clamp'
import {
  DOCUMENT_SUMMARY_SCHEMA,
  DOCUMENT_SUMMARY_SCHEMA_NAME,
  DOCUMENT_SUMMARY_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  UNIVERSAL_AUCTION_SCHEMA_ID,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
  UNIVERSAL_AUCTION_SCHEMA_VERSION,
} from './llm-schema'

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
   *  be the scanned PDF's real content (see renderPdfPagesJpeg). Page 1
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
  /** The deterministic rules pass's already-found values for propertyType/
   *  rooms/units/securityDeposit (null for whatever it didn't find). Passed
   *  along so the LLM can specifically verify or falsify each one instead of
   *  guessing blind — see `ruleCheck` in the response schema and
   *  mergeLlmResult, which only lets the LLM override a rules value that it
   *  explicitly falsified. */
  rulesHint?: RulesHint | null
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
  /** Set when resolved from an assigned LlmProviderProfile — see
   *  LlmProviderOverride.profileId. Threaded through so reprocess.ts can
   *  record which profile won the fallback chain (WP-1 provenance). */
  profileId?: string
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
  /** Tool/response-schema name sent to providers that require one
   *  (OpenAiCompatibleProvider's `response_format.json_schema.name`).
   *  Defaults to UNIVERSAL_AUCTION_SCHEMA_NAME — callers passing a
   *  different schema (see extractByLlm's opts.schema) must also pass a
   *  matching name, or every response gets mislabeled as the universal
   *  auction schema regardless of its actual shape. */
  name?: string
  parts: ContentPart[]
}

/** Token counts pulled off a provider response for cost accounting
 *  (llm-usage.ts). Either field is null when the provider didn't report it —
 *  never guessed at. */
export interface LlmUsage {
  inputTokens: number | null
  outputTokens: number | null
  /** Provider-reported USD spend when available (OpenRouter supplies this
   * for compatible responses).  Otherwise the caller uses its price table. */
  costUsd?: number | null
}

/** Narrow seam between prompt/schema building (provider-agnostic) and the
 *  wire format a specific backend expects. Swapping or adding a provider
 *  means writing a new implementation of this interface, not touching
 *  buildParts/clampExtraction. A request failure (network/HTTP error,
 *  timeout) always rejects with LlmProviderError, so a provider outage never
 *  turns into a per-auction extraction failure. When the caller passes
 *  `opts.onRequestError`, implementations resolve to null for an
 *  empty/unparseable response; without it they throw LlmProviderError for
 *  that too. A rate limit/quota error is rethrown as-is (not wrapped, not
 *  swallowed to null) — see isRateLimitError(). `opts.
 *  onRequestError` fires only for an actual request failure (network/HTTP
 *  error), never for an empty/unparseable response — reprocess.ts uses it to
 *  tell "the provider errored" apart from "the provider returned nothing",
 *  which extractByLlm's null return can't distinguish on its own. `opts.
 *  onUsage` fires once a response was actually received — including when it
 *  turns out unparseable, since tokens were spent either way — but never on
 *  a request failure (no response came back to read usage off). */
export interface ExtractionProvider {
  extract(
    req: ExtractionRequest,
    opts?: { onRequestError?: (err: unknown) => void; onUsage?: (usage: LlmUsage) => void },
  ): Promise<Record<string, unknown> | null>
}

// The old 60–80k-character caps routinely sent entire appraisals alongside
// eight gallery photos. That is disproportionate to the structured facts we
// need and exhausts an OAuth subscription long before the backlog moves.
// Keep both the beginning (object/master data) and end (valuation/conclusion)
// of a document, where those facts conventionally live.
const MAX_PDF_CHARS = 24_000
const MAX_DOCUMENT_TEXT_CHARS = 24_000

function compactDocumentText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const firstPart = Math.floor(limit * 0.7)
  const lastPart = limit - firstPart
  return `${text.slice(0, firstPart)}\n\n[... Dokumentmitte aus Budgetgründen ausgelassen ...]\n\n${text.slice(-lastPart)}`
}

/**
 * Assemble provider-neutral content parts from an LlmInput. Rendered page
 * images are omitted when native PDF parts are present, but pdfText is kept:
 * Docling Markdown describes PDFs whose native bytes are withheld, so a mixed
 * set must reach the model complete.
 */
export function buildParts(input: LlmInput): ContentPart[] {
  const text: string[] = []
  if (input.title) text.push(`Objektbezeichnung: ${input.title}`)
  if (input.description) text.push(`Beschreibung:\n${input.description}`)
  const hint = input.rulesHint
  const hintLines: string[] = []
  if (hint?.propertyType != null) hintLines.push(`Objektart: ${hint.propertyType}`)
  if (hint?.rooms != null) hintLines.push(`Zimmeranzahl: ${hint.rooms}`)
  if (hint?.units != null) hintLines.push(`Anzahl Wohneinheiten: ${hint.units}`)
  if (hint?.securityDeposit != null) hintLines.push(`Sicherheitsleistung: ${hint.securityDeposit}`)
  if (hintLines.length) {
    text.push(
      'Automatisch (regelbasiert) vorermittelte Werte zur Prüfung — können falsch sein, z. B. wenn ein ' +
        'Begriff im Text das umgebende Gebäude statt das tatsächliche Versteigerungsobjekt meint:\n' +
        hintLines.join('\n'),
    )
  }
  if (input.documentText) {
    text.push(`Weitere Dokumenttexte/HTML-Anhänge:\n${compactDocumentText(input.documentText, MAX_DOCUMENT_TEXT_CHARS)}`)
  }
  const nativeDocuments = input.pdfDocuments?.length
    ? input.pdfDocuments
    : input.pdfBytes
      ? [{ label: 'Gutachten/Exposé', data: input.pdfBytes }]
      : []
  const usingDocumentPart = nativeDocuments.length > 0
  if (input.pdfText) {
    text.push(`Auszug aus Gutachten/Exposé (PDF):\n${compactDocumentText(input.pdfText, MAX_PDF_CHARS)}`)
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
  c: { provider?: string; baseUrl?: string; apiKey?: string; model?: string; profileId?: string } | undefined,
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
    profileId: c.profileId,
    model: c.model || (provider === 'gemini-native' ? 'gemini-flash-latest' : 'claude-haiku-4-5'),
    maxTokens: overrides?.maxTokens,
  }
}

/** Returns null on empty input (without calling onProviderAttempt — no
 *  request is made, so callers must not count it as an LLM call or failure)
 *  or an unparseable response. Throws on a request failure (LlmProviderError)
 *  or a rate limit/quota error — see isRateLimitError(); left unhandled so
 *  it reaches reprocess.ts's per-candidate catch, which skips the attempt
 *  without counting a failure.
 *  `onProviderError` (see ExtractionProvider) only fires for a genuine
 *  request failure, not for parts.length === 0 (no attempt was made) or an
 *  empty/unparseable response. */
export async function extractByLlm(
  input: LlmInput,
  config: LlmConfig,
  opts: {
    onProviderAttempt?: () => void
    onProviderError?: (err: unknown) => void
    onUsage?: (usage: LlmUsage) => void
    /** Overrides the default universal-auction schema/prompt/name — used by
     *  the per-document map-reduce path (reprocess-map-reduce.ts) to request
     *  a smaller per-document schema instead. clampExtraction still applies
     *  to whatever comes back, so callers passing a schema with fewer
     *  properties than UNIVERSAL_AUCTION_SCHEMA get a ClampedExtraction with
     *  the omitted fields simply absent/null. */
    schema?: Record<string, unknown>
    systemPrompt?: string
    name?: string
  } = {},
): Promise<ClampedExtraction | null> {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  opts.onProviderAttempt?.()
  const raw = await getProvider(config).extract(
    {
      systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
      schema: opts.schema ?? UNIVERSAL_AUCTION_SCHEMA,
      name: opts.name ?? UNIVERSAL_AUCTION_SCHEMA_NAME,
      parts,
    },
    { onRequestError: opts.onProviderError, onUsage: opts.onUsage },
  )
  return raw ? clampExtraction(raw) : null
}
