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

import { PROPERTY_TYPES, type PropertyType } from '~/lib/property-type'
import { CONDITIONS, type Condition } from '~/lib/condition'
import { FEATURES, type Feature } from '~/lib/features'
import { PHOTO_CATEGORIES } from '~/lib/photo'
import type { AuctionInsights, LandParcel, PhotoCategory, PlanningNotes } from '~/types/auction'
import { ClaudeProxyProvider } from './providers/claude-proxy'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'
import { GeminiNativeProvider } from './providers/gemini-native'

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
  provider?: 'claude-proxy' | 'openai-compatible' | 'gemini-native'
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
 *  buildParts/clampExtraction. Implementations resolve to null for a request
 *  failure or unparseable response, but must throw (not swallow to null) when
 *  the failure is a rate limit/quota error — see isRateLimitError(). */
export interface ExtractionProvider {
  extract(req: ExtractionRequest): Promise<Record<string, unknown> | null>
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

export interface ClampedExtraction {
  propertyType: PropertyType | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  bedrooms: number | null
  bathrooms: number | null
  floor: string | null
  bathroomHasTub: boolean | null
  bathroomHasShower: boolean | null
  heating: string | null
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
  /** Baujahr, or null. Clamped to a plausible calendar range. */
  yearBuilt: number | null
  /** Jahr der letzten Sanierung/Modernisierung, or null. */
  lastRenovationYear: number | null
  /** Short free-text note on renovation/modernisation, or null. */
  renovationNotes: string | null
  /** Richer assessment from the appraisal, or null when nothing stood out. */
  insights: AuctionInsights | null
  /** Planning/legal notes (Denkmalschutz, Altlasten, Bauleitplanung,
   *  Grundstücksaufteilung, ...) from the appraisal, or null when nothing
   *  stood out. */
  planningNotes: PlanningNotes | null
  /** Detailed factual synthesis across every supplied listing document. */
  documentSummary?: string | null
  /** Verkehrswert (Gesamtschätzwert) explicitly stated in the Gutachten, in
   *  the auction's native currency, or null. Distinct from
   *  `insights.landValueEurPerSqm` (Bodenrichtwert, EUR/m² of the land only). */
  marketValueEur: number | null
  /** Short free-text O-Ton for `marketValueEur`, or null. */
  marketValueText: string | null
  /** LLM's curation of the `candidateImages` sent with the request, referenced
   *  by index (not filename — the model never sees real filenames). Empty
   *  when no candidateImages were sent, or none survived clamping. Callers
   *  join this back to the actual candidate file list (by `photoIndex`) to
   *  produce the filename-based `CuratedPhoto[]` stored on `AuctionExtraction`. */
  photoCuration: PhotoCuration[]
}

/** One LLM-curated candidate image, referenced by its position in the
 *  `candidateImages` list that was sent (see `LlmInput.candidateImages`). */
export interface PhotoCuration {
  photoIndex: number
  category: PhotoCategory
  caption: string | null
  isPropertyPhoto: boolean
}

// Bound the combined prose from all listing-specific PDFs. This is deliberately
// larger than the old single-document 12k window: the detailed description
// needs room for split appraisals, exposés and the official announcement.
// 60k characters is roughly a 15k-token worst-case input for non-native
// providers; native Gemini sends PDFs instead and does not consume this text
// window. Keep this explicit ceiling when adding documents so cost/latency
// cannot grow without a corresponding budget review.
const MAX_PDF_CHARS = 60_000
const MAX_DOCUMENT_TEXT_CHARS = 80_000

export const UNIVERSAL_AUCTION_SCHEMA_VERSION = 2
export const UNIVERSAL_AUCTION_SCHEMA_NAME = 'universal_auction_extraction_v2'
export const UNIVERSAL_AUCTION_SCHEMA_ID = `https://zvg-immo.local/schemas/${UNIVERSAL_AUCTION_SCHEMA_NAME}.json`

export const SYSTEM_PROMPT =
  'Du übersetzt chaotische, länderspezifische Texte und Dokumente zu Immobilienauktionen ' +
  'in ein universelles JSON-Format. Die Eingabe kann deutsch, spanisch, italienisch, ' +
  'französisch, niederländisch, tschechisch, polnisch, bosnisch, ungarisch, litauisch, ' +
  'lettisch, estnisch, schwedisch, finnisch, dänisch, isländisch oder eine andere ' +
  'europäische Sprache enthalten. Arbeite semantisch, nicht wortwörtlich: ordne lokale ' +
  'Auktions-, Gerichts-, Grundstücks- und Immobilienbegriffe den kanonischen Schemafeldern ' +
  'zu und gib Enum-Werte exakt in den erlaubten normalisierten Codes zurück. Freitexte ' +
  'wie documentSummary, biddingNotes, renovationNotes, insights.summary und planningNotes ' +
  'gibst du auf Deutsch zurück; kurze O-Ton-Beträge in marketValueText dürfen in der ' +
  'Originalsprache/-schreibweise bleiben. ' +
  'Gib die Objektart als eine der erlaubten Kategorien ' +
  'zurück und Flächen in Quadratmetern (Hektar in m² umrechnen: 1 ha = 10000 m²). ' +
  'Wohnfläche und Grundstücksfläche strikt getrennt halten. Wenn ein Wert nicht ' +
  'eindeutig im Text steht, gib null zurück — niemals raten. ' +
  'Extrahiere Schlafzimmer, Badezimmer, Etage/Geschosslage, Badewanne, Dusche und ' +
  'Heizungsart nur, wenn sie ausdrücklich genannt werden. Bei Etage/Geschosslage ' +
  'kurze Angaben wie "EG", "1. OG", "Dachgeschoss" verwenden. Badewanne/Dusche ' +
  'als true/false nur zurückgeben, wenn das Vorhandensein oder Nichtvorhandensein ' +
  'klar genannt ist; sonst null. Heizungsart/Energieträger als kurzen deutschen ' +
  'Freitext zurückgeben, z. B. "Gaszentralheizung", "Ölheizung", "Wärmepumpe" ' +
  'oder "Ofenheizung"; sonst null. ' +
  'Gib die Zimmeranzahl nur für tatsächlich vorhandene, bereits errichtete Bebauung ' +
  'zurück. Eine im Bebauungsplan oder einer Baugenehmigung genannte zulässige oder ' +
  'genehmigte Kapazität (z. B. "bis zu 250 Hotelzimmer laut Baugenehmigung") ist keine ' +
  'existierende Zimmerzahl — ein genehmigtes, aber noch unbebautes Grundstück hat null ' +
  'Zimmer. ' +
  'Gib eine Sicherheitsleistung nur zurück, wenn ein konkreter Geldbetrag in der ' +
  'Landeswährung der Anzeige im Text genannt wird (z. B. eine von der gesetzlichen ' +
  '10%-Regel abweichende Festsetzung) — niemals aus einem Prozentsatz berechnen ' +
  'oder in eine andere Währung umrechnen, sonst null. ' +
  'Gib den im Gutachten genannten Verkehrswert (Gesamtschätzwert der ' +
  'Immobilie) in der Landeswährung der Anzeige zurück, falls explizit ' +
  'genannt, sonst null — nicht zu verwechseln mit dem Bodenrichtwert ' +
  '(EUR/m² nur für das Grundstück, siehe insights). Werden für mehrere ' +
  'Flurstücke/Teilgrundstücke desselben Versteigerungsobjekts jeweils ' +
  'eigene Verkehrswerte genannt, ohne dass ein gemeinsamer Gesamtwert ' +
  'explizit dasteht, addiere sie zu einem Gesamtwert (das Objekt wird als ' +
  'ein Los versteigert). In marketValueText den O-Ton-Betrag als kurzen ' +
  'Freitext, bei einer Summe mit kurzem Hinweis (z. B. "78.000 + 8.000 EUR, ' +
  'Summe mehrerer Flurstücke"), sonst null. ' +
  'Gib in biddingNotes einen kurzen Hinweis zurück, falls der Text etwas ' +
  'Ungewöhnliches zum Bietverfahren nennt (abweichende Sicherheitsleistung, ' +
  'ungewöhnliche Zahlungsfrist o. Ä.), sonst null. ' +
  'Gib außerdem den Zustand als eine der erlaubten Kategorien zurück, nur wenn er ' +
  'eindeutig aus dem Text hervorgeht (z.B. "kernsaniert"/"neuwertig" → neuwertig, ' +
  '"Sanierungsstau" → sanierungsbeduerftig, "renovierungsbedürftig" → renovierungsbeduerftig), sonst null. ' +
  'Gib eine Liste erkannter Ausstattungsmerkmale zurück — nur Merkmale, die explizit ' +
  'im Text genannt werden (Negation beachten, z.B. "kein Balkon" nicht aufnehmen), ' +
  'sonst eine leere Liste. Niemals raten. ' +
  'Gib das Baujahr zurück, falls im Text eindeutig genannt, sonst null. Gib das Jahr der ' +
  'letzten Sanierung/Modernisierung zurück, falls eindeutig genannt, sonst null, und in ' +
  'renovationNotes einen kurzen Freitext-Hinweis dazu, sonst null. ' +
  'Erstelle außerdem in documentSummary eine ausführliche, sachliche Zusammenfassung ' +
  'aus ALLEN bereitgestellten objektbezogenen Dokumenten und der Anzeige. Führe die ' +
  'wesentlichen Angaben zu Objekt und Nutzung, Lage, Flächen, Bauweise und Zustand, ' +
  'Modernisierungen, Mängeln, rechtlichen oder planerischen Besonderheiten sowie ' +
  'Wertermittlung in gut lesbaren Absätzen zusammen. Widersprüche zwischen Dokumenten ' +
  'kenntlich machen und keine Tatsachen ergänzen. Allgemeine, nicht objektspezifische ' +
  'Biet- oder Gerichtshinweise nicht wiederholen. Ziel sind etwa 5 bis 10 kompakte ' +
  'Absätze; null nur, wenn außer dem bereits gelieferten Anzeigentext keine verwertbaren ' +
  'Objektinformationen vorhanden sind. ' +
  'Extrahiere zusätzlich, sofern im Gutachten enthalten, eine reichhaltigere Einschätzung ' +
  '(insights): defects (Mängel/Schäden/Sanierungsstau), encumbrances (Belastungen wie ' +
  'Wohnrecht/Nießbrauch/Dienstbarkeiten), landValueEurPerSqm (Bodenrichtwert in EUR/m²), ' +
  'construction (Bauweise/Konstruktion), locationCharacter (Lagecharakter) und summary ' +
  '(kurze Gesamteinschätzung, 2-4 Sätze). Gib insights insgesamt als null zurück, wenn das ' +
  'Gutachten keine dieser Angaben enthält. Niemals raten. ' +
  'Extrahiere außerdem, sofern im Gutachten enthalten (typischerweise in einer Tabelle ' +
  '"weitere Zustandsmerkmale" oder ähnlich betitelt), planerische/rechtliche Hinweise ' +
  '(planningNotes) als kurzen Freitext je Feld: monumentProtection (Denkmalschutz, O-Ton), ' +
  'contamination (Altlasten), developmentPlan (Bauleitplanung/Bebauungsplan-Festsetzung), ' +
  'landConsolidation (Bodenordnung), developmentCharges (Erschließungs-/Ausbaubeiträge), ' +
  'redevelopmentArea (Sanierungsgebiet), conservationArea (Erhaltungsgebiet). Ein "kein(e) ' +
  'X bekannt/vorhanden"-Hinweis zählt als vorhandene Angabe (kurz wiedergeben), nicht als ' +
  'null — null nur wenn das Gutachten das Thema gar nicht erwähnt. Extrahiere außerdem, ' +
  'sofern im Gutachten enthalten (z. B. Abschnitt "wertmethodische Aufteilung des ' +
  'Grundstückes" oder "Aufteilung auf die Flurstücke"), die Aufteilung des Grundstücks in ' +
  'landParcels: eine Liste aus label (Teilflächen- oder Flurstücksbezeichnung, z. B. ' +
  '"Teilfläche A" oder "743/1"), areaSqm (Fläche in m², oder null) und use (Nutzung/Zweck, ' +
  'z. B. "gewerbliche Baufläche", oder null). Leere Liste, wenn keine Aufteilung genannt ' +
  'wird. Gib planningNotes insgesamt als null zurück, wenn keines der Felder und keine ' +
  'landParcels-Einträge im Gutachten stehen. Niemals raten. ' +
  'Falls Kandidatenbilder mitgesendet werden (jeweils mit vorangestelltem "Bild N:"-Label), ' +
  'kuratiere jedes Bild im photos-Array: photoIndex (der Index aus dem Label), category ' +
  '(aussen/innen/grundriss/lageplan/sonstiges), caption (kurze Bildunterschrift oder null) ' +
  'und isPropertyPhoto (true nur bei einem echten Objektfoto, also Außen-/Innenansicht der ' +
  'Immobilie; false bei Lageplan, Grundriss, Wappen, Deckblatt oder Textseite). Wurden keine ' +
  'Bilder mitgesendet, gib ein leeres photos-Array zurück.'

export const UNIVERSAL_AUCTION_SCHEMA = {
  description:
    'Kanonisches, länder- und sprachunabhängiges Zielformat für aus Auktionstexten und Dokumenten extrahierte Immobilien-Eckdaten.',
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
    rooms: {
      type: ['number', 'null'],
      description:
        'Zimmeranzahl der tatsächlich existierenden Bebauung, oder null. Genehmigte/zulässige Kapazität aus Bebauungsplan oder Baugenehmigung zählt nicht.',
    },
    bedrooms: { type: ['number', 'null'], description: 'Schlafzimmeranzahl, oder null wenn unklar.' },
    bathrooms: { type: ['number', 'null'], description: 'Badezimmeranzahl, oder null wenn unklar.' },
    floor: {
      type: ['string', 'null'],
      description: 'Etage/Geschosslage bei Wohnungen als kurzer Text (z. B. EG, 1. OG, Dachgeschoss), oder null.',
    },
    bathroomHasTub: {
      type: ['boolean', 'null'],
      description: 'true/false wenn Badewanne ausdrücklich vorhanden/nicht vorhanden ist, sonst null.',
    },
    bathroomHasShower: {
      type: ['boolean', 'null'],
      description: 'true/false wenn Dusche ausdrücklich vorhanden/nicht vorhanden ist, sonst null.',
    },
    heating: {
      type: ['string', 'null'],
      description: 'Heizungsart/Energieträger als kurzer deutscher Freitext, oder null.',
    },
    units: { type: ['integer', 'null'], description: 'Anzahl Wohneinheiten.' },
    securityDeposit: {
      type: ['number', 'null'],
      description: 'Explizit genannte Sicherheitsleistung in der Landeswährung der Anzeige, oder null.',
    },
    marketValueEur: {
      type: ['number', 'null'],
      description:
        'Im Gutachten genannter Verkehrswert (Gesamtschätzwert) in der Landeswährung der Anzeige, oder null. Nicht der Bodenrichtwert. Bei mehreren Flurstücken mit je eigenem Verkehrswert und ohne genannten Gesamtwert: Summe.',
    },
    marketValueText: {
      type: ['string', 'null'],
      description: 'O-Ton-Betrag zu marketValueEur, oder null.',
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
    yearBuilt: { type: ['integer', 'null'], description: 'Baujahr, oder null wenn unklar.' },
    lastRenovationYear: {
      type: ['integer', 'null'],
      description: 'Jahr der letzten Sanierung/Modernisierung, oder null wenn unklar.',
    },
    renovationNotes: {
      type: ['string', 'null'],
      description: 'Kurzer Hinweis zu Sanierung/Modernisierung, oder null.',
    },
    insights: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Reichhaltigere Einschätzung aus dem Gutachten, oder null wenn nichts Nennenswertes.',
      properties: {
        defects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Mängel/Schäden/Sanierungsstau, leer wenn keine genannt.',
        },
        encumbrances: {
          type: 'array',
          items: { type: 'string' },
          description: 'Belastungen (Wohnrecht, Nießbrauch, Dienstbarkeiten, ...), leer wenn keine genannt.',
        },
        landValueEurPerSqm: {
          type: ['number', 'null'],
          description: 'Bodenrichtwert in EUR/m², oder null.',
        },
        construction: { type: ['string', 'null'], description: 'Bauweise/Konstruktion, oder null.' },
        locationCharacter: { type: ['string', 'null'], description: 'Lagecharakter, oder null.' },
        summary: { type: ['string', 'null'], description: 'Kurze Gesamteinschätzung (2-4 Sätze), oder null.' },
      },
      required: [
        'defects',
        'encumbrances',
        'landValueEurPerSqm',
        'construction',
        'locationCharacter',
        'summary',
      ],
    },
    planningNotes: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Planerische/rechtliche Hinweise aus dem Gutachten, oder null wenn nichts Nennenswertes.',
      properties: {
        monumentProtection: { type: ['string', 'null'], description: 'Denkmalschutz-Hinweis (O-Ton), oder null.' },
        contamination: { type: ['string', 'null'], description: 'Altlasten-Hinweis, oder null.' },
        developmentPlan: { type: ['string', 'null'], description: 'Bauleitplanung/B-Plan-Festsetzung, oder null.' },
        landConsolidation: { type: ['string', 'null'], description: 'Bodenordnung, oder null.' },
        developmentCharges: {
          type: ['string', 'null'],
          description: 'Erschließungs-/Ausbaubeiträge, oder null.',
        },
        redevelopmentArea: { type: ['string', 'null'], description: 'Sanierungsgebiet, oder null.' },
        conservationArea: { type: ['string', 'null'], description: 'Erhaltungsgebiet, oder null.' },
        landParcels: {
          type: 'array',
          description: 'Aufteilung des Grundstücks in Teilflächen/Flurstücke, leer wenn keine genannt.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', description: 'Teilflächen- oder Flurstücksbezeichnung.' },
              areaSqm: { type: ['number', 'null'], description: 'Fläche in m², oder null.' },
              use: { type: ['string', 'null'], description: 'Nutzung/Zweck, oder null.' },
            },
            required: ['label', 'areaSqm', 'use'],
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
    documentSummary: {
      type: ['string', 'null'],
      description:
        'Ausführliche sachliche Zusammenfassung aller bereitgestellten objektbezogenen Dokumente in etwa 5 bis 10 kompakten Absätzen, oder null.',
    },
    photos: {
      type: 'array',
      description:
        'Kuratierung der mitgesendeten Kandidatenbilder ("Bild N:"-Label), höchstens ein Eintrag pro Bild; leeres Array wenn keine Bilder mitgesendet wurden.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          photoIndex: { type: 'integer', description: '0-basierter Index des Bildes (siehe "Bild N:"-Label).' },
          category: {
            type: 'string',
            enum: PHOTO_CATEGORIES,
            description: 'Kategorie des Bildes.',
          },
          caption: { type: ['string', 'null'], description: 'Kurze Bildunterschrift, oder null.' },
          isPropertyPhoto: {
            type: 'boolean',
            description:
              'true bei echtem Objektfoto (Außen-/Innenansicht), false bei Lageplan/Grundriss/Wappen/Deckblatt/Textseite.',
          },
        },
        required: ['photoIndex', 'category', 'caption', 'isPropertyPhoto'],
      },
    },
  },
  required: [
    'propertyType',
    'landAreaSqm',
    'livingAreaSqm',
    'rooms',
    'bedrooms',
    'bathrooms',
    'floor',
    'bathroomHasTub',
    'bathroomHasShower',
    'heating',
    'units',
    'securityDeposit',
    'marketValueEur',
    'marketValueText',
    'biddingNotes',
    'condition',
    'features',
    'yearBuilt',
    'lastRenovationYear',
    'renovationNotes',
    'insights',
    'planningNotes',
    'documentSummary',
    'photos',
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
const VALID_PHOTO_CATEGORIES = new Set<string>(PHOTO_CATEGORIES)

function plausibleArea(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null
}

function plausibleCount(v: unknown, max: number, opts: { allowZero?: boolean } = {}): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const minOk = opts.allowZero ? v >= 0 : v > 0
  return minOk && v <= max ? v : null
}

// Reject non-years and absurd values; upper bound is the current year (evaluated
// at call time so a "built next year" hallucination is dropped rather than
// hard-coding a cutoff that ages).
function clampYear(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const year = Math.round(v)
  return year >= 1800 && year <= new Date().getFullYear() ? year : null
}

function trimmedString(v: unknown, maxLen: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, maxLen) : null
}

// A bounded list of trimmed, non-empty strings — caps both count and per-item
// length so a runaway appraisal enumeration can't bloat the cache row.
function clampStringList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    const s = trimmedString(item, maxLen)
    if (s) out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

function clampInsights(raw: unknown): AuctionInsights | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const insights: AuctionInsights = {
    defects: clampStringList(r.defects, 20, 200),
    encumbrances: clampStringList(r.encumbrances, 20, 200),
    landValueEurPerSqm: plausibleArea(r.landValueEurPerSqm, 1_000_000),
    construction: trimmedString(r.construction, 200),
    locationCharacter: trimmedString(r.locationCharacter, 200),
    summary: trimmedString(r.summary, 500),
  }
  // `insights` is documented as null when no appraisal data survives clamping;
  // an object of only empty lists/nulls would violate that contract.
  const hasData =
    insights.defects.length > 0 ||
    insights.encumbrances.length > 0 ||
    insights.landValueEurPerSqm != null ||
    insights.construction != null ||
    insights.locationCharacter != null ||
    insights.summary != null
  return hasData ? insights : null
}

function clampLandParcels(raw: unknown): LandParcel[] {
  if (!Array.isArray(raw)) return []
  const out: LandParcel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const label = trimmedString(r.label, 100)
    if (!label) continue
    out.push({ label, areaSqm: plausibleArea(r.areaSqm, 100_000_000), use: trimmedString(r.use, 200) })
    if (out.length >= 30) break
  }
  return out
}

function clampPlanningNotes(raw: unknown): PlanningNotes | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const notes: PlanningNotes = {
    monumentProtection: trimmedString(r.monumentProtection, 300),
    contamination: trimmedString(r.contamination, 300),
    developmentPlan: trimmedString(r.developmentPlan, 300),
    landConsolidation: trimmedString(r.landConsolidation, 300),
    developmentCharges: trimmedString(r.developmentCharges, 300),
    redevelopmentArea: trimmedString(r.redevelopmentArea, 300),
    conservationArea: trimmedString(r.conservationArea, 300),
    landParcels: clampLandParcels(r.landParcels),
  }
  const hasData =
    notes.monumentProtection != null ||
    notes.contamination != null ||
    notes.developmentPlan != null ||
    notes.landConsolidation != null ||
    notes.developmentCharges != null ||
    notes.redevelopmentArea != null ||
    notes.conservationArea != null ||
    notes.landParcels.length > 0
  return hasData ? notes : null
}

// Defensive against malformed LLM output: an entry with no valid photoIndex
// is dropped rather than defaulted, since a wrong index would silently
// mislabel an unrelated candidate image.
function clampPhotoCuration(raw: unknown): PhotoCuration[] {
  if (!Array.isArray(raw)) return []
  const out: PhotoCuration[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const photoIndex = Number.isInteger(r.photoIndex) && (r.photoIndex as number) >= 0
      ? (r.photoIndex as number)
      : null
    if (photoIndex == null) continue
    const category = typeof r.category === 'string' && VALID_PHOTO_CATEGORIES.has(r.category)
      ? (r.category as PhotoCategory)
      : 'sonstiges'
    out.push({
      photoIndex,
      category,
      caption: trimmedString(r.caption, 200),
      isPropertyPhoto: typeof r.isPropertyPhoto === 'boolean' ? r.isPropertyPhoto : true,
    })
  }
  return out
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
  const biddingNotes = trimmedString(raw.biddingNotes, 300)
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
    bedrooms: plausibleCount(raw.bedrooms, 100, { allowZero: true }),
    bathrooms: plausibleArea(raw.bathrooms, 100),
    floor: trimmedString(raw.floor, 80),
    bathroomHasTub: typeof raw.bathroomHasTub === 'boolean' ? raw.bathroomHasTub : null,
    bathroomHasShower: typeof raw.bathroomHasShower === 'boolean' ? raw.bathroomHasShower : null,
    heating: trimmedString(raw.heating, 160),
    units: units == null ? null : Math.round(units),
    // Upper bound generous but finite — a plausibility guard against the LLM
    // accidentally echoing an unrelated large figure (e.g. the Verkehrswert
    // itself), not a real-world deposit ceiling.
    securityDeposit: plausibleArea(raw.securityDeposit, 100_000_000),
    marketValueEur: plausibleArea(raw.marketValueEur, 1_000_000_000),
    marketValueText: trimmedString(raw.marketValueText, 200),
    biddingNotes,
    condition,
    features,
    yearBuilt: clampYear(raw.yearBuilt),
    lastRenovationYear: clampYear(raw.lastRenovationYear),
    renovationNotes: trimmedString(raw.renovationNotes, 300),
    insights: clampInsights(raw.insights),
    planningNotes: clampPlanningNotes(raw.planningNotes),
    documentSummary: trimmedString(raw.documentSummary, 8_000),
    photoCuration: clampPhotoCuration(raw.photos),
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
  // Interleaved with an index label right before each image so the model can
  // reliably report `photoIndex` back — a bare image sequence gives it
  // nothing stable to reference.
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
  const provider = c.provider === 'claude-proxy' || c.provider === 'gemini-native' ? c.provider : 'openai-compatible'
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
 *  candidate catch, which skips the attempt without counting a failure. */
export async function extractByLlm(
  input: LlmInput,
  config: LlmConfig,
): Promise<ClampedExtraction | null> {
  const parts = buildParts(input)
  if (parts.length === 0) return null
  const raw = await getProvider(config).extract({
    systemPrompt: SYSTEM_PROMPT,
    schema: UNIVERSAL_AUCTION_SCHEMA,
    parts,
  })
  return raw ? clampExtraction(raw) : null
}
