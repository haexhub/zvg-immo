// LLM fallback extractor. Sends the listing text (title + description +
// optional Gutachten/Exposé PDF text) to a Claude model via haex-claude-proxy
// and gets back structured fields through the proxy's `final_result` output
// tool (it forwards the tool's input_schema to `claude --json-schema`). Used
// for what the deterministic rules can't resolve: sizes buried in PDF prose,
// and property types for non-German sources the property-type classifier misses.
//
// Optionally vision: when `pdfImageBase64` is set (a scanned/image-only
// Gutachten PDF where pdftotext returned nothing usable — see
// server/tasks/enrich.ts), the rendered page image is sent alongside the
// prompt instead of relying on text alone. parseExtractionResponse/
// clampExtraction are pure and unit-tested; the network call is a thin wrapper.

import { PROPERTY_TYPES, type PropertyType } from '~/lib/property-type'

export interface LlmInput {
  title: string | null
  description: string | null
  pdfText?: string | null
  /** Base64 JPEG of a Gutachten page, used when pdfText is too sparse to be
   *  the scanned PDF's real content (see pdfPageToBase64Jpeg). */
  pdfImageBase64?: string | null
}

export interface LlmConfig {
  baseUrl: string
  model: string
  maxTokens?: number
}

export interface ClampedExtraction {
  propertyType: PropertyType | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  units: number | null
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
  'eindeutig im Text steht, gib null zurück — niemals raten.'

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
  },
  required: ['propertyType', 'landAreaSqm', 'livingAreaSqm', 'rooms', 'units'],
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
  return {
    propertyType: pt,
    landAreaSqm: plausibleArea(raw.landAreaSqm, 100_000_000),
    livingAreaSqm: plausibleArea(raw.livingAreaSqm, 1_000_000),
    rooms: plausibleArea(raw.rooms, 100),
    units: units == null ? null : Math.round(units),
  }
}

function buildPrompt(input: LlmInput): string {
  const parts: string[] = []
  if (input.title) parts.push(`Objektbezeichnung: ${input.title}`)
  if (input.description) parts.push(`Beschreibung:\n${input.description}`)
  if (input.pdfText) {
    parts.push(`Auszug aus Gutachten/Exposé (PDF):\n${input.pdfText.slice(0, MAX_PDF_CHARS)}`)
  }
  if (input.pdfImageBase64) {
    parts.push(
      'Das Gutachten/Exposé liegt als eingescanntes Bild vor (siehe angehängtes Bild) — lies die Eckdaten daraus ab.',
    )
  }
  return parts.join('\n\n')
}

/** Returns null on empty input, request failure, or unparseable response. */
export async function extractByLlm(
  input: LlmInput,
  config: LlmConfig,
): Promise<ClampedExtraction | null> {
  const prompt = buildPrompt(input)
  if (!prompt.trim() && !input.pdfImageBase64) return null
  const content = input.pdfImageBase64
    ? [
        { type: 'text', text: prompt },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: input.pdfImageBase64 },
        },
      ]
    : prompt
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    tools: [
      {
        name: 'final_result',
        description: 'Gib die extrahierten Eckdaten zurück.',
        input_schema: EXTRACTION_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'final_result' },
  }
  let resp: unknown
  try {
    // Bound the request: the proxy spawns a `claude` subprocess per call, so a
    // stuck spawn (or upstream stall) would keep this promise pending forever
    // and — because the enrich task awaits every worker via Promise.all — block
    // the whole run.
    resp = await $fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body,
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    console.warn(`[extract/llm] request failed: ${(err as Error).message}`)
    return null
  }
  const raw = parseExtractionResponse(resp)
  return raw ? clampExtraction(raw) : null
}
