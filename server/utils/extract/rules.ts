import { classifyObjekt, type PropertyType } from '~/lib/objektart'
import { findLandAreaSqm, findLivingAreaSqm, findRooms, findUnits } from './sizes'

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
  const cat = classifyObjekt(text || null)
  const propertyType: PropertyType | null =
    cat.id === 'unbekannt' ? null : (cat.id as PropertyType)

  const livingAreaSqm = findLivingAreaSqm(text)
  const landAreaSqm = findLandAreaSqm(text)
  const rooms = findRooms(text)
  const units = findUnits(text)

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
