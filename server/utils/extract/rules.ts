import { classifyObjekt, type PropertyType } from '~/lib/objektart'
import { findLandAreaSqm, findLivingAreaSqm, findRooms, findUnits, parseAreaValue } from './sizes'

// Which area bucket an unlabeled "153.80 m²" in the objekt string belongs to,
// by property type. Commercial/garage/sonstiges stay unassigned — their bare
// areas are too ambiguous (hall floor? plot?) for a deterministic pass.
// House types (einfamilienhaus, zweifamilienhaus, doppelhaushaelfte,
// reihenhaus) are deliberately excluded too: the bare figure in a house
// listing's short title ("Einfamilienhaus, 850 m²") is at least as often the
// plot size as the living area, and a wrong bucket here would be cached as
// confident and never corrected by the LLM.
const LIVING_AREA_TYPES = new Set<PropertyType>([
  'eigentumswohnung',
  'mehrfamilienhaus',
  'wohn-geschaefts',
])
const LAND_AREA_TYPES = new Set<PropertyType>(['land-forst', 'unbebaut'])

export interface ExtractionInput {
  objekt: string | null
  beschreibung: string | null
}

export interface RulesExtraction {
  propertyType: PropertyType | null
  livingAreaSqm: number | null
  landAreaSqm: number | null
  rooms: number | null
  units: number | null
  /** True when a real type AND at least one area were found — i.e. good enough
   *  to skip the LLM fallback. */
  confident: boolean
}

/**
 * Deterministic first pass: classify the property type from the existing
 * objektart taxonomy and parse sizes from the combined listing text. Returns
 * `confident: false` for thin/ambiguous input so the caller can fall back to
 * the LLM.
 */
export function extractByRules(input: ExtractionInput): RulesExtraction {
  const text = [input.objekt, input.beschreibung].filter(Boolean).join('\n')
  // Classify the structured `objekt` field first: prose in the beschreibung
  // ("Eigentumswohnung im 3. OG eines Mehrfamilienhauses") would otherwise
  // hit a higher-priority rule and misclassify. Only fall back to the
  // combined text when objekt yields nothing usable.
  let cat = classifyObjekt(input.objekt)
  if (cat.id === 'unbekannt' || cat.id === 'sonstiges') {
    cat = classifyObjekt(text || null)
  }
  const propertyType: PropertyType | null =
    cat.id === 'unbekannt' ? null : (cat.id as PropertyType)

  let livingAreaSqm = findLivingAreaSqm(text)
  let landAreaSqm = findLandAreaSqm(text)
  const rooms = findRooms(text)
  const units = findUnits(text)

  // Unlabeled fallback: many platforms put a bare area into the short objekt
  // string ("Stanovanje 13,50 m2", "Κατάστημα 153.80 τ.μ."). Without a label
  // the value can't be bucketed by text alone, but an unambiguous property
  // type implies the bucket. Only the objekt field is safe for this — prose
  // in the beschreibung mentions all kinds of areas.
  if (livingAreaSqm == null && landAreaSqm == null && input.objekt && propertyType) {
    const bare = parseAreaValue(input.objekt)
    if (bare != null) {
      if (LIVING_AREA_TYPES.has(propertyType)) livingAreaSqm = bare
      else if (LAND_AREA_TYPES.has(propertyType)) landAreaSqm = bare
    }
  }

  const hasArea = livingAreaSqm != null || landAreaSqm != null
  const hasRealType = propertyType != null && propertyType !== 'sonstiges'

  return {
    propertyType,
    livingAreaSqm,
    landAreaSqm,
    rooms,
    units,
    confident: hasRealType && hasArea,
  }
}
