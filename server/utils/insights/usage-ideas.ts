// "Nutzungsideen" — the first concrete instance of the generic insight
// framework (see registry.ts). Suggests plausible uses for a foreclosure-
// auction property (Eigennutzung, Ferienwohnung, Landwirtschaft, ...),
// grounded strictly in the extracted facts/Gutachten prose already on file.

import type { Auction } from '~/types/auction'
import { USAGE_IDEA_TYPES, type UsageIdea } from '~/lib/usage-idea'
import type { InsightDefinition } from './registry'

const MAX_DOCUMENT_SUMMARY_CHARS = 6000
const MAX_IDEAS = 6
const MAX_LABEL_CHARS = 60
const MAX_RATIONALE_CHARS = 500

const SYSTEM_PROMPT =
  'Du bist ein Immobilienberater, der einem Bieter bei einer Zwangsversteigerung plausible ' +
  'Nutzungsideen für das Objekt vorschlägt. Du bekommst die bereits extrahierten Objektdaten ' +
  'und Gutachten-/Expose-Auszüge. Stütze jede Idee ausschließlich auf die gelieferten Daten — ' +
  'erfinde niemals Fakten und schlage niemals eine Nutzung vor, die den Daten widerspricht. ' +
  'Erlaubte Nutzungsideen-Typen: ' +
  '"owner-occupation" (Eigennutzung als Wohnsitz) — Standardfall, fast immer plausibel. ' +
  '"owner-occupation-with-sublet" (Eigennutzung mit Untervermietung) — nur wenn units > 1 ' +
  'oder eine separate Einliegerwohnung/zweite Einheit aus den Daten hervorgeht. ' +
  '"vacation-rental" (Ferienwohnung) — nur wenn Lagecharakter oder Region touristisch ' +
  'plausibel sind (z. B. Berg-/See-/Küstenlage, bekannte Urlaubsregion); nicht bei gewöhnlicher ' +
  'Stadt-/Wohnlage ohne jeden touristischen Hinweis. ' +
  '"farm" (Bauernhof) — nur bei erkennbarer landwirtschaftlicher Hofstelle mit Wohn- und ' +
  'Wirtschaftsgebäuden. ' +
  '"agricultural" (Landwirtschaft) — nur wenn propertyType "land-forst" ist oder Flurstücke/' +
  'Zusammenfassung landwirtschaftliche Nutzung (Ackerland, Weide, ...) nennen. ' +
  '"forestry" (Forstwirtschaft) — nur wenn Flurstücke/Zusammenfassung ausdrücklich Wald/Forst ' +
  'nennen, oder propertyType "land-forst" mit großer Grundstücksfläche. ' +
  '"warehouse" (Lagerhaus) — nur bei erkennbarer Gewerbe-/Lagerhalle. ' +
  '"other" (Sonstiges) — für eine plausible Nutzung, die in keine der obigen Kategorien passt; ' +
  'label/rationale müssen die Idee dann konkret benennen. ' +
  'Gib 1 bis 5 Ideen zurück, nach Plausibilität absteigend sortiert — lieber wenige gut ' +
  'begründete Ideen als aufgefüllte Vorschläge. Wenn kaum Daten vorliegen (keine Flurstücke, ' +
  'kein Lagecharakter, keine Zusammenfassung), gib in der Regel nur "owner-occupation" zurück ' +
  'und sag in der rationale, dass die Datenlage dünn ist. Setze confidence "high" nur, wenn die ' +
  'Idee direkt durch konkrete Fakten gedeckt ist, sonst "low", oder null wenn nicht einschätzbar.'

const USAGE_IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ideas: {
      type: 'array',
      description: '1 bis 5 plausible Nutzungsideen, nach Plausibilität absteigend sortiert.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: USAGE_IDEA_TYPES, description: 'Einer der erlaubten Nutzungsideen-Typen.' },
          label: { type: 'string', description: 'Kurzer deutscher Titel der Idee (z. B. "Eigennutzung").' },
          rationale: {
            type: 'string',
            description: 'Kurze deutsche Begründung, warum diese Nutzung anhand der Daten plausibel ist.',
          },
          confidence: { type: ['string', 'null'], enum: ['high', 'low', null] },
        },
        required: ['type', 'label', 'rationale', 'confidence'],
      },
    },
  },
  required: ['ideas'],
} as const

function buildContentHashInput(auction: Auction): Record<string, unknown> {
  const extraction = auction.extraction ?? null
  const insights = extraction?.insights ?? null
  return {
    propertyType: extraction?.propertyType ?? null,
    landAreaSqm: extraction?.landAreaSqm ?? null,
    livingAreaSqm: extraction?.livingAreaSqm ?? null,
    rooms: extraction?.rooms ?? null,
    units: extraction?.units ?? null,
    condition: extraction?.condition ?? null,
    features: extraction?.features ?? null,
    planningNotes: extraction?.planningNotes ?? null,
    locationCharacter: insights?.locationCharacter ?? null,
    construction: insights?.construction ?? null,
    insightsSummary: insights?.summary ?? null,
    documentSummary: extraction?.documentSummary?.slice(0, MAX_DOCUMENT_SUMMARY_CHARS) ?? null,
    country: auction.country,
    region: auction.region,
  }
}

function buildPrompt(auction: Auction): { systemPrompt: string; userText: string } {
  const input = buildContentHashInput(auction)
  const userText =
    'Schlage anhand der folgenden Objektdaten plausible Nutzungsideen vor.\n\n' +
    `OBJEKTDATEN_JSON:\n${JSON.stringify(input, null, 2)}`
  return { systemPrompt: SYSTEM_PROMPT, userText }
}

function clamp(raw: unknown): UsageIdea[] | null {
  if (!raw || typeof raw !== 'object') return null
  const ideas = (raw as Record<string, unknown>).ideas
  if (!Array.isArray(ideas)) return null

  const seen = new Set<string>()
  const clamped: UsageIdea[] = []
  for (const entry of ideas) {
    if (clamped.length >= MAX_IDEAS) break
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const type = typeof e.type === 'string' ? e.type : null
    const label = typeof e.label === 'string' ? e.label.trim() : ''
    const rationale = typeof e.rationale === 'string' ? e.rationale.trim() : ''
    if (!type || !(USAGE_IDEA_TYPES as readonly string[]).includes(type)) continue
    if (!label || !rationale) continue
    if (seen.has(type)) continue
    seen.add(type)
    const confidence = e.confidence === 'high' || e.confidence === 'low' ? e.confidence : null
    clamped.push({
      type: type as UsageIdea['type'],
      label: label.slice(0, MAX_LABEL_CHARS),
      rationale: rationale.slice(0, MAX_RATIONALE_CHARS),
      confidence,
    })
  }
  return clamped.length ? clamped : null
}

export const usageIdeasInsight: InsightDefinition<UsageIdea[]> = {
  id: 'usage-ideas',
  maxTokensDefault: 1536,
  rateLimitPerHourPerIp: 20,
  promptVersion: 1,
  buildContentHashInput,
  buildPrompt,
  schema: USAGE_IDEAS_SCHEMA,
  clamp,
}
