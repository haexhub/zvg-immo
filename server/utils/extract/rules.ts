import { classifyObjekt, type PropertyType } from '~/lib/objektart'
import { findLandAreaSqm, findLivingAreaSqm, findRooms, findUnits, parseAreaValue } from './sizes'

// Which area bucket an unlabeled "153.80 m²" in the objekt string belongs to,
// by property type. Commercial/garage/sonstiges stay unassigned — their bare
// areas are too ambiguous (hall floor? plot?) for a deterministic pass.
const LIVING_AREA_TYPES = new Set<PropertyType>([
  'eigentumswohnung',
  'einfamilienhaus',
  'zweifamilienhaus',
  'mehrfamilienhaus',
  'doppelhaushaelfte',
  'reihenhaus',
  'wohn-geschaefts',
])
const LAND_AREA_TYPES = new Set<PropertyType>(['land-forst', 'unbebaut'])

export type AreaBucket = 'living' | 'land' | null

/**
 * Which area bucket a property type belongs to. Shared by crawlers whose
 * source exposes a free-text category (agi/at/lt/hu/fr-avoventes) instead of
 * a labeled area — each maps its own vocabulary to a representative
 * PropertyType (its source's category text doesn't share objektart.ts's
 * conservative bare-word-free regexes, so classifyObjekt isn't a drop-in
 * replacement there) and calls this to decide the bucket. Source-specific
 * *code* mappings (e.g. si's numeric propertyKind codes) stay local.
 */
export function areaBucketForPropertyType(propertyType: PropertyType | null): AreaBucket {
  if (propertyType == null) return null
  if (LIVING_AREA_TYPES.has(propertyType)) return 'living'
  if (LAND_AREA_TYPES.has(propertyType)) return 'land'
  return null
}

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
      const bucket = areaBucketForPropertyType(propertyType)
      if (bucket === 'living') livingAreaSqm = bare
      else if (bucket === 'land') landAreaSqm = bare
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
