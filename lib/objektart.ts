export interface ObjektKategorie {
  id: string
  label: string
}

/** Canonical property-type ids the rules/LLM extractor may emit. Mirrors the
 *  RULES ids below plus 'sonstiges'. 'unbekannt' is represented as null. */
export type PropertyType =
  | 'mehrfamilienhaus'
  | 'zweifamilienhaus'
  | 'wohn-geschaefts'
  | 'doppelhaushaelfte'
  | 'reihenhaus'
  | 'einfamilienhaus'
  | 'eigentumswohnung'
  | 'gewerbe'
  | 'land-forst'
  | 'unbebaut'
  | 'garage-stellplatz'
  | 'sonstiges'

/** Runtime list of the PropertyType union — for LLM schema enums and validation
 *  (TypeScript can't enumerate a type at runtime). Keep in sync with the union. */
export const PROPERTY_TYPES: readonly PropertyType[] = [
  'mehrfamilienhaus',
  'zweifamilienhaus',
  'wohn-geschaefts',
  'doppelhaushaelfte',
  'reihenhaus',
  'einfamilienhaus',
  'eigentumswohnung',
  'gewerbe',
  'land-forst',
  'unbebaut',
  'garage-stellplatz',
  'sonstiges',
]

interface KategorieRule extends ObjektKategorie {
  test: RegExp
}

// Priority order: the first rule whose test matches the raw `objekt` string
// wins. Compound entries like "Einfamilienhaus, Garage" classify as
// Einfamilienhaus because that rule fires before the standalone-garage rule.
// More specific / dominant types come first, accessory types last.
const RULES: KategorieRule[] = [
  { id: 'mehrfamilienhaus', label: 'Mehrfamilienhaus', test: /mehrfamilienhaus|dreifamilienhaus/i },
  { id: 'zweifamilienhaus', label: 'Zweifamilienhaus', test: /zweifamilienhaus/i },
  // Matches "Wohn- und Geschäftshaus", "Wohn-/Geschäftshaus", "Wohn/Geschäftshaus".
  { id: 'wohn-geschaefts', label: 'Wohn-/Geschäftshaus', test: /wohn-?\s*(?:und\s+|\/\s*)?geschäftshaus/i },
  { id: 'doppelhaushaelfte', label: 'Doppelhaushälfte', test: /doppelhaushälfte/i },
  { id: 'reihenhaus', label: 'Reihenhaus', test: /reihenhaus/i },
  { id: 'einfamilienhaus', label: 'Einfamilienhaus', test: /einfamilienhaus/i },
  {
    id: 'eigentumswohnung',
    label: 'Eigentumswohnung',
    test: /eigentumswohnung|sonstiges teileigentum|wohnung und anteil/i,
  },
  { id: 'gewerbe', label: 'Gewerbe', test: /gewerb/i },
  { id: 'land-forst', label: 'Land-/Forstwirtschaft', test: /forstwirtschaft|landwirt|ackerland/i },
  { id: 'unbebaut', label: 'Unbebautes Grundstück', test: /unbebautes grundstück|baugrundstück/i },
  {
    id: 'garage-stellplatz',
    label: 'Garage / Stellplatz',
    // Substring match on purpose: compounds and plurals ("Tiefgaragenstellplatz",
    // "Doppelgarage", "Garagen", "Stellplätze") must classify as garage too.
    test: /garage|stellpl(?:atz|ätze)/i,
  },
]

const SONSTIGES: ObjektKategorie = { id: 'sonstiges', label: 'Sonstiges' }
const UNBEKANNT: ObjektKategorie = { id: 'unbekannt', label: 'Unbekannt' }

export function classifyObjekt(objekt: string | null | undefined): ObjektKategorie {
  if (!objekt) return UNBEKANNT
  for (const r of RULES) {
    if (r.test.test(objekt)) return { id: r.id, label: r.label }
  }
  return SONSTIGES
}

/** All categories classifyObjekt can return, in display order. */
export const ALL_KATEGORIEN: readonly ObjektKategorie[] = [
  ...RULES.map((r) => ({ id: r.id, label: r.label })),
  SONSTIGES,
  UNBEKANNT,
] as const
