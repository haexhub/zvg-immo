// Free-text LLM completions for the on-demand summary/translation endpoints
// (as opposed to extractByLlm's structured field extraction). Reuses the same
// provider abstraction (getProvider/ExtractionProvider) as extraction: every
// provider already speaks a forced-JSON-schema wire format, so wrapping the
// wanted output in a single-field schema gets free text back through
// whichever backend runtimeConfig.extractLlm.provider actually selects,
// instead of a caller hardcoding Anthropic's /v1/messages format directly and
// silently breaking when the config points at a different provider.

import { getProvider, type LlmConfig, type LlmUsage } from './llm'
import type {
  TranslatableExtractionTexts,
  TranslatableInsightsTexts,
  TranslatablePlanningNotesTexts,
} from '~/lib/extraction-translation'

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
    address: {
      type: ['string', 'null'],
      description:
        'Übersetzte/transliterierte Adresse, oder null wenn keine Adresse vorhanden war. Verwaltungsbegriffe und ' +
        'Abkürzungen (Ortsteil-Präfixe, Straße, Platz, Bezirk, Hausnummer-Zeichen) in die im Zielsprachraum übliche ' +
        'Form bringen und Eigennamen in nicht-lateinischer Schrift lateinisch transliterieren. Reihenfolge der ' +
        'Adressbestandteile nicht ändern, keine Bestandteile erfinden oder weglassen.',
    },
    description: {
      type: ['string', 'null'],
      description: 'Übersetzte Beschreibung, oder null wenn keine Beschreibung vorhanden war.',
    },
    documentSummary: {
      type: ['string', 'null'],
      description: 'Übersetzte Dokument-Zusammenfassung, oder null wenn keine vorhanden war.',
    },
    extractionTexts: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        biddingNotes: { type: ['string', 'null'] },
        renovationNotes: { type: ['string', 'null'] },
        floor: { type: ['string', 'null'] },
        heating: {
          type: ['string', 'null'],
          description: 'Translate as short user-facing amenity text, preserving the technical meaning.',
        },
        insights: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            defects: { type: 'array', items: { type: 'string' } },
            encumbrances: { type: 'array', items: { type: 'string' } },
            construction: {
              type: ['string', 'null'],
              description: 'Translate construction/material/foundation/window/roof terms into the target language when possible.',
            },
            locationCharacter: { type: ['string', 'null'] },
            summary: { type: ['string', 'null'] },
          },
          required: ['defects', 'encumbrances', 'construction', 'locationCharacter', 'summary'],
        },
        planningNotes: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            monumentProtection: { type: ['string', 'null'] },
            contamination: { type: ['string', 'null'] },
            developmentPlan: { type: ['string', 'null'] },
            landConsolidation: { type: ['string', 'null'] },
            developmentCharges: { type: ['string', 'null'] },
            redevelopmentArea: { type: ['string', 'null'] },
            conservationArea: { type: ['string', 'null'] },
            landParcels: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: ['string', 'null'] },
                  use: { type: ['string', 'null'] },
                },
                required: ['label', 'use'],
              },
            },
          },
          required: [
            'monumentProtection',
            'contamination',
            'developmentPlan',
            'landConsolidation',
            'developmentCharges',
            'redevelopmentArea',
            'conservationArea',
            'landParcels',
          ],
        },
      },
      required: ['biddingNotes', 'renovationNotes', 'floor', 'heating', 'insights', 'planningNotes'],
    },
  },
  required: ['title', 'address', 'description', 'documentSummary', 'extractionTexts'],
} as const

export interface TranslationResult {
  title: string | null
  address: string | null
  description: string | null
  documentSummary: string | null
  extractionTexts: TranslatableExtractionTexts | null
}

function translatedString(raw: unknown, source: string | null): string | null | undefined {
  const value = typeof raw === 'string' ? raw.trim() : null
  if (source != null && !value) return undefined
  return source == null ? null : value
}

function translatedStringArray(raw: unknown, source: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length !== source.length) return null
  const out = raw.map((value) => (typeof value === 'string' ? value.trim() : ''))
  return out.every(Boolean) ? out : null
}

function translatedInsights(raw: unknown, source: TranslatableInsightsTexts | null): TranslatableInsightsTexts | null | undefined {
  if (source == null) return null
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const defects = translatedStringArray(obj.defects, source.defects)
  const encumbrances = translatedStringArray(obj.encumbrances, source.encumbrances)
  const construction = translatedString(obj.construction, source.construction)
  const locationCharacter = translatedString(obj.locationCharacter, source.locationCharacter)
  const summary = translatedString(obj.summary, source.summary)
  if (!defects || !encumbrances || construction === undefined || locationCharacter === undefined || summary === undefined) {
    return undefined
  }
  return { defects, encumbrances, construction, locationCharacter, summary }
}

function translatedPlanningNotes(
  raw: unknown,
  source: TranslatablePlanningNotesTexts | null,
): TranslatablePlanningNotesTexts | null | undefined {
  if (source == null) return null
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const monumentProtection = translatedString(obj.monumentProtection, source.monumentProtection)
  const contamination = translatedString(obj.contamination, source.contamination)
  const developmentPlan = translatedString(obj.developmentPlan, source.developmentPlan)
  const landConsolidation = translatedString(obj.landConsolidation, source.landConsolidation)
  const developmentCharges = translatedString(obj.developmentCharges, source.developmentCharges)
  const redevelopmentArea = translatedString(obj.redevelopmentArea, source.redevelopmentArea)
  const conservationArea = translatedString(obj.conservationArea, source.conservationArea)
  const rawParcels = obj.landParcels
  if (!Array.isArray(rawParcels) || rawParcels.length !== source.landParcels.length) return undefined
  const landParcels = rawParcels.map((rawParcel, i) => {
    if (!rawParcel || typeof rawParcel !== 'object') return undefined
    const rawParcelObj = rawParcel as Record<string, unknown>
    const label = translatedString(rawParcelObj.label, source.landParcels[i]?.label ?? null)
    const use = translatedString(rawParcelObj.use, source.landParcels[i]?.use ?? null)
    if (label === undefined || use === undefined) return undefined
    return { label, use }
  })
  if (
    monumentProtection === undefined ||
    contamination === undefined ||
    developmentPlan === undefined ||
    landConsolidation === undefined ||
    developmentCharges === undefined ||
    redevelopmentArea === undefined ||
    conservationArea === undefined ||
    landParcels.some((parcel) => parcel === undefined)
  ) {
    return undefined
  }
  return {
    monumentProtection,
    contamination,
    developmentPlan,
    landConsolidation,
    developmentCharges,
    redevelopmentArea,
    conservationArea,
    landParcels: landParcels as TranslatablePlanningNotesTexts['landParcels'],
  }
}

function translatedExtractionTexts(
  raw: unknown,
  source: TranslatableExtractionTexts | null,
): TranslatableExtractionTexts | null | undefined {
  if (source == null) return null
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const biddingNotes = translatedString(obj.biddingNotes, source.biddingNotes)
  const renovationNotes = translatedString(obj.renovationNotes, source.renovationNotes)
  const floor = translatedString(obj.floor, source.floor)
  const heating = translatedString(obj.heating, source.heating)
  const insights = translatedInsights(obj.insights, source.insights)
  const planningNotes = translatedPlanningNotes(obj.planningNotes, source.planningNotes)
  if (
    biddingNotes === undefined ||
    renovationNotes === undefined ||
    floor === undefined ||
    heating === undefined ||
    insights === undefined ||
    planningNotes === undefined
  ) {
    return undefined
  }
  return { biddingNotes, renovationNotes, floor, heating, insights, planningNotes }
}

/** Returns null on request failure, or when a populated source field came
 *  back empty — signals failure rather than caching an untranslated fallback
 *  forever under an "auto-translated" label (the caller's cache is immutable
 *  per content_hash+lang). */
export async function callTranslationLlm(
  systemPrompt: string,
  userText: string,
  title: string | null,
  address: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: TranslatableExtractionTexts | null,
  config: LlmConfig,
  onUsage?: (usage: LlmUsage) => void,
): Promise<TranslationResult | null> {
  const raw = await getProvider(config).extract(
    {
      systemPrompt,
      schema: TRANSLATION_SCHEMA,
      parts: [{ type: 'text', text: userText }],
    },
    { onUsage },
  )
  if (!raw) return null
  const translatedTitle = typeof raw.title === 'string' ? raw.title.trim() : null
  const translatedAddress = typeof raw.address === 'string' ? raw.address.trim() : null
  const translatedDescription = typeof raw.description === 'string' ? raw.description.trim() : null
  const translatedDocumentSummary = typeof raw.documentSummary === 'string' ? raw.documentSummary.trim() : null
  const translatedExtraction = translatedExtractionTexts(raw.extractionTexts, extractionTexts)
  if (title != null && !translatedTitle) return null
  if (address != null && !translatedAddress) return null
  if (description != null && !translatedDescription) return null
  if (documentSummary != null && !translatedDocumentSummary) return null
  if (translatedExtraction === undefined) return null
  return {
    title: title == null ? null : translatedTitle,
    address: address == null ? null : translatedAddress,
    description: description == null ? null : translatedDescription,
    documentSummary: documentSummary == null ? null : translatedDocumentSummary,
    extractionTexts: translatedExtraction,
  }
}

const PLACE_NAME_TRANSLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    names: { type: 'array', items: { type: 'string' } },
  },
  required: ['names'],
} as const

/** Translates/transliterates a batch of OSM place names (settlements,
 *  industrial sites, airports — see osm-location-shared.ts's nameOf()) in one
 *  call. Returns null on request failure or if the model doesn't return
 *  exactly one output per input in the same order — a length mismatch can't
 *  be safely zipped back to the source names. */
export async function callPlaceNameTranslationLlm(
  names: readonly string[],
  targetLangName: string,
  config: LlmConfig,
  onUsage?: (usage: LlmUsage) => void,
): Promise<string[] | null> {
  const systemPrompt =
    'Du übersetzt/transliterierst geographische Eigennamen (Städte, Dörfer, Industriestandorte, Flughäfen). ' +
    'Nutze den international gebräuchlichen Namen, wenn es einen gibt (z. B. "Bukarest" für "București"); ' +
    'ansonsten transliteriere nicht-lateinische Schrift originalgetreu in lateinische Schrift. ' +
    'Erfinde keine Namen und ändere die Bedeutung nicht.'
  const userText = [
    `Translate/transliterate each of the following place names into ${targetLangName}.`,
    'Return exactly one output per input, in the same order — never merge, split, drop or add entries.',
    '',
    JSON.stringify(names),
  ].join('\n')
  const raw = await getProvider(config).extract(
    {
      systemPrompt,
      schema: PLACE_NAME_TRANSLATION_SCHEMA,
      parts: [{ type: 'text', text: userText }],
    },
    { onUsage },
  )
  const translated = raw?.names
  if (!Array.isArray(translated) || translated.length !== names.length) return null
  const out = translated.map((value) => (typeof value === 'string' ? value.trim() : ''))
  return out.every(Boolean) ? out : null
}
