import { CONDITIONS, type Condition } from '~/lib/condition'
import { FEATURES, type Feature } from '~/lib/features'
import { PHOTO_CATEGORIES } from '~/lib/photo'
import { PROPERTY_TYPES, type PropertyType } from '~/lib/property-type'
import type { AuctionInsights, LandParcel, PhotoCategory, PlanningNotes } from '~/types/auction'

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
 *  `candidateImages` list that was sent. */
export interface PhotoCuration {
  photoIndex: number
  category: PhotoCategory
  caption: string | null
  isPropertyPhoto: boolean
  appealScore: number
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

function clampPhotoCuration(raw: unknown): PhotoCuration[] {
  if (!Array.isArray(raw)) return []
  const out: PhotoCuration[] = []
  const seen = new Set<number>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const photoIndex = Number.isInteger(r.photoIndex) && (r.photoIndex as number) >= 0
      ? (r.photoIndex as number)
      : null
    if (photoIndex == null) continue
    if (seen.has(photoIndex)) continue
    seen.add(photoIndex)
    const category = typeof r.category === 'string' && VALID_PHOTO_CATEGORIES.has(r.category)
      ? (r.category as PhotoCategory)
      : 'sonstiges'
    out.push({
      photoIndex,
      category,
      caption: trimmedString(r.caption, 200),
      isPropertyPhoto: typeof r.isPropertyPhoto === 'boolean' ? r.isPropertyPhoto : false,
      appealScore: typeof r.appealScore === 'number' && Number.isFinite(r.appealScore)
        ? Math.max(0, Math.min(100, Math.round(r.appealScore)))
        : 0,
    })
    if (out.length >= 60) break
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
  const units = plausibleCount(raw.units, 10_000)
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
    rooms: plausibleCount(raw.rooms, 100, { allowZero: true }),
    bedrooms: plausibleCount(raw.bedrooms, 100, { allowZero: true }),
    bathrooms: plausibleCount(raw.bathrooms, 100, { allowZero: true }),
    floor: trimmedString(raw.floor, 80),
    bathroomHasTub: typeof raw.bathroomHasTub === 'boolean' ? raw.bathroomHasTub : null,
    bathroomHasShower: typeof raw.bathroomHasShower === 'boolean' ? raw.bathroomHasShower : null,
    heating: trimmedString(raw.heating, 160),
    units: units == null ? null : Math.round(units),
    securityDeposit: plausibleCount(raw.securityDeposit, 100_000_000),
    marketValueEur: plausibleCount(raw.marketValueEur, 1_000_000_000),
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
