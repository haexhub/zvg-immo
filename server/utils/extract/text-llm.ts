// Free-text LLM completions for the on-demand summary/translation endpoints
// (as opposed to extractByLlm's structured field extraction). Reuses the same
// provider abstraction (getProvider/ExtractionProvider) as extraction: every
// provider already speaks a forced-JSON-schema wire format, so wrapping the
// wanted output in a single-field schema gets free text back through
// whichever backend runtimeConfig.extractLlm.provider actually selects,
// instead of a caller hardcoding Anthropic's /v1/messages format directly and
// silently breaking when the config points at a different provider.

import { getProvider, type LlmConfig } from './llm'

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Die vollständige Zusammenfassung als Markdown-Text.' },
  },
  required: ['summary'],
} as const

/** Returns null on request failure or an empty/unparseable summary field. */
export async function callSummaryLlm(
  systemPrompt: string,
  userText: string,
  config: LlmConfig,
): Promise<string | null> {
  const raw = await getProvider(config).extract({
    systemPrompt,
    schema: SUMMARY_SCHEMA,
    parts: [{ type: 'text', text: userText }],
  })
  const summary = raw?.summary
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null
}

const TRANSLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: ['string', 'null'], description: 'Übersetzter Titel, oder null wenn kein Titel vorhanden war.' },
    description: {
      type: ['string', 'null'],
      description: 'Übersetzte Beschreibung, oder null wenn keine Beschreibung vorhanden war.',
    },
  },
  required: ['title', 'description'],
} as const

export interface TranslationResult {
  title: string | null
  description: string | null
}

/** Returns null on request failure, or when the source had a title/description
 *  but the model came back empty for it — signals failure rather than caching
 *  an untranslated fallback forever under an "auto-translated" label (the
 *  caller's cache is immutable per content_hash+lang). */
export async function callTranslationLlm(
  systemPrompt: string,
  userText: string,
  title: string | null,
  description: string | null,
  config: LlmConfig,
): Promise<TranslationResult | null> {
  const raw = await getProvider(config).extract({
    systemPrompt,
    schema: TRANSLATION_SCHEMA,
    parts: [{ type: 'text', text: userText }],
  })
  if (!raw) return null
  const translatedTitle = typeof raw.title === 'string' ? raw.title.trim() : null
  const translatedDescription = typeof raw.description === 'string' ? raw.description.trim() : null
  if (title != null && !translatedTitle) return null
  if (description != null && !translatedDescription) return null
  return {
    title: title == null ? null : translatedTitle,
    description: description == null ? null : translatedDescription,
  }
}
