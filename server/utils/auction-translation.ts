// Auction translation prompt and content identity, shared by the public lazy
// translation route (server/api/auction/[platform]/[id]/translation.post.ts)
// and the admin retry (translation-retry.ts) so both send the same prompt and
// key their caches by the same content hash.

import { sha256Hex } from '~/server/utils/raw-archive'
import type { LlmUsage } from '~/server/utils/extract/llm'
import { callTranslationLlm, type TranslationResult } from '~/server/utils/extract/text-llm'
import type { ContentTargetLang } from '~/lib/content-language'
import { type extractTranslatableExtractionTexts, translationContentSource } from '~/lib/extraction-translation'
import type { Auction } from '~/types/auction'

const LANG_NAMES: Record<ContentTargetLang, string> = { de: 'German', en: 'English' }
const LANGUAGE_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })

function languageName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES.of(code) ?? code
}

const SYSTEM_PROMPT =
  'Du bist ein präziser Übersetzer für Anzeigen von Immobilien-Zwangsversteigerungen. ' +
  'Übersetze wörtlich und originalgetreu — keine Ausschmückung, keine Zusammenfassung. ' +
  'Alle vollständigen Sätze müssen in der Zielsprache stehen. Fach- und Rechtsbegriffe nur dann unverändert lassen, ' +
  'wenn es wirklich kein zuverlässiges Äquivalent gibt; keine Originalbegriffe mit Klammerübersetzung ausgeben.'

/** Builds a labelled prompt so nullable fields retain their identity. */
function buildPrompt(
  title: string | null,
  address: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
  sourceLang: string | null,
): string {
  const sourceHint = sourceLang
    ? `The source portal normally publishes this auction in ${languageName(sourceLang)}. If an individual field is in another language, detect it and still translate it into ${LANG_NAMES[targetLang]}.`
    : `Detect the source language of each field and translate it into ${LANG_NAMES[targetLang]}.`
  const lines = [
    `Translate the following real-estate foreclosure auction text fields into ${LANG_NAMES[targetLang]}.`,
    sourceHint,
    'Return the same JSON shape. Translate every string value. Keep nulls, array order, array lengths, identifiers, dates, numbers and currencies unchanged.',
    'Do not leave whole source-language sentences unchanged. Do not write source terms followed by target-language translations in parentheses; use the target-language term directly.',
    'ADDRESS is a property address, not prose: localize administrative terms/abbreviations (street, square, district, house-number sign, place-name prefixes) into the target-language convention, and transliterate non-Latin-script proper nouns into Latin script. Keep the same component order; do not invent or drop components.',
    'EXTRACTION_TEXTS_JSON contains short structured labels shown in the property detail UI. Translate heating and insights.construction as user-facing amenity text, including material, roof, window, foundation and building-services terms. Keep an original specialist term only when there is no reliable target-language equivalent.',
    '',
    `TITLE: ${title ?? ''}`,
    `ADDRESS: ${address ?? ''}`,
    `DESCRIPTION:\n${description ?? ''}`,
    `DOCUMENT_SUMMARY:\n${documentSummary ?? ''}`,
    `EXTRACTION_TEXTS_JSON:\n${JSON.stringify(extractionTexts ?? null, null, 2)}`,
  ]
  return lines.join('\n')
}

export async function tryTranslate(
  title: string | null,
  address: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
  sourceLang: string | null,
  config: Parameters<typeof callTranslationLlm>[7],
  onUsage?: (usage: LlmUsage) => void,
): Promise<TranslationResult | null> {
  return await callTranslationLlm(
    SYSTEM_PROMPT,
    buildPrompt(title, address, description, documentSummary, extractionTexts, targetLang, sourceLang),
    title,
    address,
    description,
    documentSummary,
    extractionTexts,
    config,
    onUsage,
  )
}

export function auctionTranslationContentHash(auction: Pick<Auction, 'title' | 'address' | 'description' | 'extraction'>): string {
  return sha256Hex(Buffer.from(JSON.stringify(translationContentSource(auction))))
}
