// LLM fallback extractor. Sends the listing text (title + description +
// optional Gutachten/Exposé PDF text) to an LLM provider and gets back
// structured fields through a forced-schema tool/response-format call. Used
// for what the deterministic rules can't resolve: sizes buried in PDF prose,
// and property types for non-German sources the property-type classifier misses.
//
// Optionally vision: when `pdfPageImages` is set (a scanned/image-only
// Gutachten PDF where pdftotext returned nothing usable — see
// server/tasks/enrich.ts), the rendered page images are sent alongside the
// prompt instead of relying on text alone. parseExtractionResponse/
// clampExtraction are pure and unit-tested; the network call is a thin wrapper.

import { PROPERTY_TYPES, type PropertyType } from '~/lib/property-type'
import { CONDITIONS, type Condition } from '~/lib/condition'
import { FEATURES, type Feature } from '~/lib/features'
import { ClaudeProxyProvider } from './providers/claude-proxy'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'

export interface LlmInput {
  title: string | null
  description: string | null
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
   *  code change. 'claude-proxy' is the transitional Anthropic-format path. */
  provider?: 'claude-proxy' | 'openai-compatible'
  baseUrl: string
  apiKey?: string
  model: string
  maxTokens?: number
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
 *  buildParts/clampExtraction. */
export interface ExtractionProvider {
  extract(req: ExtractionRequest): Promise<Record<string, unknown> | null>
}

export interface ClampedExtraction {
  propertyType: PropertyType | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  units: number | null
  /** Explicit security-deposit amount in the auction's native currency, only
   *  when the text states one directly (e.g. a German court deviating from
   *  the unpublished 10% default) — never derived from a percentage or
   *  converted, since the LLM doesn't see the auction's Verkehrswert or
   *  exchange rate to compute one. */
  securityDeposit: number | null
  /** Short free-text note on anything unusual about the bidding process
   *  (a deviating deposit rule, an atypical payment deadline, ...), or null. */
  biddingNotes: string | null
  condition: Condition | null
  features: Feature[]
}

// Bound PDF prose so a 40-page Gutachten doesn't blow the token budget. The
// size/type facts are almost always in the first pages.
const MAX_PDF_CHARS = 12_000

const SYSTEM_PROMPT =
  'Du extrahierst strukturierte Eckdaten aus Anzeigen für Immobilien-' +
  'Zwangsversteigerungen (Texte können deutsch, spanisch, italienisch, französisch, ' +
  'niederländisch, tschechisch, polnisch, bosnisch, ungarisch, litauisch, lettisch, ' +
  'estnisch, schwedisch, finnisch, dänisch oder isländisch sein). ' +
  'Gib die Objektart als eine der erlaubten Kategorien ' +
  'zurück und Flächen in Quadratmetern (Hektar in m² umrechnen: 1 ha = 10000 m²). ' +
  'Wohnfläche und Grundstücksfläche strikt getrennt halten. Wenn ein Wert nicht ' +
  'eindeutig im Text steht, gib null zurück — niemals raten. ' +
  'Gib eine Sicherheitsleistung nur zurück, wenn ein konkreter Geldbetrag in der ' +
  'Landeswährung der Anzeige im Text genannt wird (z. B. eine von der gesetzlichen ' +
  '10%-Regel abweichende Festsetzung) — niemals aus einem Prozentsatz berechnen ' +
  'oder in eine andere Währung umrechnen, sonst null. ' +
  'Gib in biddingNotes einen kurzen Hinweis zurück, falls der Text etwas ' +
  'Ungewöhnliches zum Bietverfahren nennt (abweichende Sicherheitsleistung, ' +
  'ungewöhnliche Zahlungsfrist o. Ä.), sonst null. ' +
  'Gib außerdem den Zustand als eine der erlaubten Kategorien zurück, nur wenn er ' +
  'eindeutig aus dem Text hervorgeht (z.B. "kernsaniert"/"neuwertig" → neuwertig, ' +
  '"Sanierungsstau" → sanierungsbeduerftig, "renovierungsbedürftig" → renovierungsbeduerftig), sonst null. ' +
  'Gib eine Liste erkannter Ausstattungsmerkmale zurück — nur Merkmale, die explizit ' +
  'im Text genannt werden (Negation beachten, z.B. "kein Balkon" nicht aufnehmen), ' +
  'sonst eine leere Liste. Niemals raten.'

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    propertyType: {
      type: ['string', 'null'],
      enum: [...PROPERTY_TYPES, null],
      description: 'Objektart, oder null wenn unklar.',
    },
    landAreaSqm: { type: ['number', 'null'], description: 'Grundstücksfläche in m².' },
    livingAreaSqm: { type: ['number', 'null'], description: 'Wohnfläche in m².' },
    rooms: { type: ['number', 'null'], description: 'Zimmeranzahl.' },
    units: { type: ['integer', 'null'], description: 'Anzahl Wohneinheiten.' },
    securityDeposit: {
      type: ['number', 'null'],
      description: 'Explizit genannte Sicherheitsleistung in der Landeswährung der Anzeige, oder null.',
    },
    biddingNotes: {
      type: ['string', 'null'],
      description: 'Kurzer Hinweis zu Besonderheiten des Bietverfahrens, oder null.',
    },
    condition: {
      type: ['string', 'null'],
      enum: [...CONDITIONS, null],
      description: 'Zustand der Immobilie, oder null wenn unklar.',
    },
    features: {
      type: 'array',
      items: { type: 'string', enum: FEATURES },
      description: 'Erkannte Ausstattungsmerkmale, leer wenn keine eindeutig genannt.',
    },
  },
  required: [
    'propertyType',
    'landAreaSqm',
    'livingAreaSqm',
    'rooms',
    'units',
    'securityDeposit',
    'biddingNotes',
    'condition',
    'features',
  ],
} as const

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

const VALID_TYPES = new Set<string>(PROPERTY_TYPES)
const VALID_CONDITIONS = new Set<string>(CONDITIONS)
const VALID_FEATURES = new Set<string>(FEATURES)

function plausibleArea(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null
}

/**
 * Per-field plausibility bounds only — reject negatives, non-numbers and absurd
 * magnitudes, and unknown property types. No cross-field rules (a multi-storey
 * building's living area can exceed its plot; an ETW's plot is shared).
 */
export function clampExtraction(raw: Record<string, unknown>): ClampedExtraction {
  const pt = typeof raw.propertyType === 'string' && VALID_TYPES.has(raw.propertyType)
    ? (raw.propertyType as PropertyType)
    : null
  const units = plausibleArea(raw.units, 10_000)
  const biddingNotes =
    typeof raw.biddingNotes === 'string' && raw.biddingNotes.trim()
      ? raw.biddingNotes.trim().slice(0, 300)
      : null
  const condition = typeof raw.condition === 'string' && VALID_CONDITIONS.has(raw.condition)
    ? (raw.condition as Condition)
    : null
  const features = Array.isArray(raw.features)
    ? [...new Set(raw.features.filter((f): f is Feature => typeof f === 'string' && VALID_FEATURES.has(f)))]
    : []
  return {
    propertyType: pt,
    landAreaSqm: plausibleArea(raw.landAreaSqm, 100_000_000),
    livingAreaSqm: plausibleArea(raw.livingAreaSqm, 1_000_000),
    rooms: plausibleArea(raw.rooms, 100),
    units: units == null ? null : Math.round(units),
    // Upper bound generous but finite — a plausibility guard against the LLM
    // accidentally echoing an unrelated large figure (e.g. the Verkehrswert
    // itself), not a real-world deposit ceiling.
    securityDeposit: plausibleArea(raw.securityDeposit, 100_000_000),
    biddingNotes,
    condition,
    features,
  }
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
  const usingDocumentPart = !!input.pdfBytes
  if (input.pdfText && !usingDocumentPart) {
    text.push(`Auszug aus Gutachten/Exposé (PDF):\n${input.pdfText.slice(0, MAX_PDF_CHARS)}`)
  }
  if (input.pdfPageImages?.length && !usingDocumentPart) {
    text.push(
      'Das Gutachten/Exposé liegt als eingescanntes Bild vor (siehe angehängte Bilder) — lies die Eckdaten daraus ab.',
    )
  }

  const parts: ContentPart[] = []
  if (text.length) parts.push({ type: 'text', text: text.join('\n\n') })
  if (usingDocumentPart) {
    parts.push({ type: 'document', mimeType: 'application/pdf', data: input.pdfBytes! })
  } else if (input.pdfPageImages?.length) {
    for (const data of input.pdfPageImages) parts.push({ type: 'image', mimeType: 'image/jpeg', data })
  }
  return parts
}

function getProvider(config: LlmConfig): ExtractionProvider {
  switch (config.provider ?? 'openai-compatible') {
    case 'claude-proxy':
      return new ClaudeProxyProvider(config)
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(config)
    default:
      throw new Error(`Unknown extraction provider: ${config.provider}`)
  }
}

/** Returns null on empty input, request failure, or unparseable response. */
export async function extractByLlm(
  input: LlmInput,
  config: LlmConfig,
): Promise<ClampedExtraction | null> {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  const raw = await getProvider(config).extract({
    systemPrompt: SYSTEM_PROMPT,
    schema: EXTRACTION_SCHEMA,
    parts,
  })
  return raw ? clampExtraction(raw) : null
}
