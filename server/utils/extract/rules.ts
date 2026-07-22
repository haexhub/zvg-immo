import { classifyPropertyType, type PropertyType } from '~/lib/property-type'
import { findLandAreaSqm, findLivingAreaSqm, findRooms, findUnits, parseAreaValue, parseLocaleNumber } from './sizes'

// Which area bucket an unlabeled "153.80 m²" in the title string belongs to,
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

export type AreaBucket = 'living' | 'land' | null

/**
 * Which area bucket a property type belongs to. Shared by crawlers whose
 * source exposes a free-text category (agi/at/lt/hu/fr-avoventes) instead of
 * a labeled area — each maps its own vocabulary to a representative
 * PropertyType (its source's category text doesn't share property-type.ts's
 * conservative bare-word-free regexes, so classifyPropertyType isn't a drop-in
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
  title: string | null
  description: string | null
}

export interface RulesExtraction {
  propertyType: PropertyType | null
  livingAreaSqm: number | null
  landAreaSqm: number | null
  rooms: number | null
  units: number | null
  /** Explicit security-deposit amount, only when the announcement states an
   *  absolute figure next to the label (see findSecurityDepositEur). */
  securityDeposit: number | null
  /** True when a real type AND at least one area were found — i.e. good enough
   *  to skip the LLM fallback. */
  confident: boolean
}

// German ZVG announcements almost never restate a Sicherheitsleistung amount:
// the statutory default (10% of Verkehrswert, § 68 Abs. 3 ZVG) is implicit
// and unpublished — verified by sampling real zvg-portal Bekanntmachungen,
// which mention "Sicherheitsleistung" only as payment-routing boilerplate
// (IBAN, "Stichwort Sicherheit") with no amount attached. This only fires on
// an explicit absolute figure immediately followed by a currency marker, so
// it can't mistake IBAN digits or unrelated numbers nearby for the deposit.
const SECURITY_DEPOSIT_RE = /Sicherheitsleistung\D{0,30}?([\d.,]+)\s*(?:€|EUR\b)/i

export function findSecurityDepositEur(text: string): number | null {
  const m = text.match(SECURITY_DEPOSIT_RE)
  return m && m[1] ? parseLocaleNumber(m[1]) : null
}

/**
 * Deterministic first pass: classify the property type from the existing
 * property-type taxonomy and parse sizes from the combined listing text. Returns
 * `confident: false` for thin/ambiguous input so the caller can fall back to
 * the LLM.
 */
export function extractByRules(input: ExtractionInput): RulesExtraction {
  const text = [input.title, input.description].filter(Boolean).join('\n')
  // Classify the structured `title` field first: prose in the description
  // ("Eigentumswohnung im 3. OG eines Mehrfamilienhauses") would otherwise
  // hit a higher-priority rule and misclassify. Only fall back to the
  // combined text when title yields nothing usable.
  let cat = classifyPropertyType(input.title)
  if (cat.id === 'unbekannt' || cat.id === 'sonstiges') {
    cat = classifyPropertyType(text || null)
  }
  const propertyType: PropertyType | null =
    cat.id === 'unbekannt' ? null : (cat.id as PropertyType)

  let livingAreaSqm = findLivingAreaSqm(text)
  let landAreaSqm = findLandAreaSqm(text)
  const rooms = findRooms(text)
  const units = findUnits(text)

  // Unlabeled fallback: many platforms put a bare area into the short title
  // string ("Stanovanje 13,50 m2", "Κατάστημα 153.80 τ.μ."). Without a label
  // the value can't be bucketed by text alone, but an unambiguous property
  // type implies the bucket. Only the title field is safe for this — prose
  // in the description mentions all kinds of areas.
  if (livingAreaSqm == null && landAreaSqm == null && input.title && propertyType) {
    const bare = parseAreaValue(input.title)
    if (bare != null) {
      const bucket = areaBucketForPropertyType(propertyType)
      if (bucket === 'living') livingAreaSqm = bare
      else if (bucket === 'land') landAreaSqm = bare
    }
  }

  const hasArea = livingAreaSqm != null || landAreaSqm != null
  const hasRealType = propertyType != null && propertyType !== 'sonstiges'
  const securityDeposit = findSecurityDepositEur(text)

  return {
    propertyType,
    livingAreaSqm,
    landAreaSqm,
    rooms,
    units,
    securityDeposit,
    confident: hasRealType && hasArea,
  }
}
