// Shared merge step between rules-derived fields and an LLM extraction
// attempt — factored out because reprocess.ts's sync path and its LLM Batch
// API poll path (llm-batch-poll.ts) both need the exact same precedence
// rules: for propertyType/rooms/units/securityDeposit, a rules value wins
// unless rules found nothing (LLM fills the gap) or the LLM explicitly
// falsified it via ruleCheck — see llm-schema.ts, which shows the LLM the
// rules value and asks it to verify or falsify rather than guess blind, so a
// plain independent LLM guess never silently overrides a value rules already
// resolved. condition/features/yearBuilt/lastRenovationYear/renovationNotes/
// insights/marketValueEur/marketValueText/biddingNotes are LLM-only and
// always take the latest call's result. Pure function, no I/O — easy to
// unit-test independently of any provider or cache.

import type { PropertyType } from '~/lib/property-type'
import type { Condition } from '~/lib/condition'
import type { Feature } from '~/lib/features'
import type { AuctionExtraction, AuctionInsights, CuratedPhoto, PlanningNotes } from '~/types/auction'
import type { ClampedExtraction } from './llm'

/** Rules/structured fields plus the LLM-only fields carried forward from a
 *  prior cache entry (undefined when never checked) — the state going into
 *  the merge, before this call's LLM result (if any) is applied. */
export interface MergeInputFields {
  propertyType: PropertyType | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  floor?: string | null
  bathroomHasTub?: boolean | null
  bathroomHasShower?: boolean | null
  heating?: string | null
  units: number | null
  securityDeposit: number | null
  biddingNotes?: string | null
  condition?: Condition | null
  features?: Feature[]
  yearBuilt?: number | null
  lastRenovationYear?: number | null
  renovationNotes?: string | null
  insights?: AuctionInsights | null
  planningNotes?: PlanningNotes | null
  documentSummary?: string | null
  marketValueEur?: number | null
  marketValueText?: string | null
}

export function deriveLandAreaSqmFromPlanningNotes(planningNotes: PlanningNotes | null | undefined): number | null {
  const parcels = planningNotes?.landParcels
  if (!parcels?.length) return null
  let total = 0
  for (const parcel of parcels) {
    const area = parcel.areaSqm
    if (typeof area !== 'number' || !Number.isFinite(area) || area <= 0) return null
    total += area
  }
  return total > 0 ? Math.round(total * 100) / 100 : null
}

export function withDerivedExtractionFields(entry: AuctionExtraction): AuctionExtraction {
  const parcelLandAreaSqm = deriveLandAreaSqmFromPlanningNotes(entry.planningNotes)
  const derivedLandAreaSqm =
    entry.landAreaSqm == null || (parcelLandAreaSqm != null && parcelLandAreaSqm > entry.landAreaSqm + 1)
      ? parcelLandAreaSqm
      : entry.landAreaSqm
  if (derivedLandAreaSqm == null || derivedLandAreaSqm === entry.landAreaSqm) return entry

  const hasType = entry.propertyType != null && entry.propertyType !== 'sonstiges'
  const hasArea = derivedLandAreaSqm != null || entry.livingAreaSqm != null
  return {
    ...entry,
    landAreaSqm: derivedLandAreaSqm,
    confidence: hasType && hasArea ? 'high' : entry.confidence,
  }
}

/** Resolves one rules/LLM field pair for propertyType/rooms/units/
 *  securityDeposit: a null rules value takes the LLM's own guess (a genuine
 *  gap, nothing to override); a non-null rules value stays unless `verified`
 *  is explicitly `false` (the LLM was shown the rules value via
 *  LlmInput.rulesHint and falsified it — see llm-schema.ts's ruleCheck).
 *  `verified` being `true` or `null` (agrees, or no hint was sent for this
 *  field) both keep the rules value. */
function resolveVerifiedField<T>(
  ruleValue: T | null,
  llmValue: T | null,
  verified: boolean | null | undefined,
): { value: T | null; usedLlm: boolean } {
  if (ruleValue == null) return { value: llmValue, usedLlm: llmValue != null }
  if (verified === false) return { value: llmValue, usedLlm: true }
  return { value: ruleValue, usedLlm: false }
}

/**
 * Merges `fields` with an LLM extraction attempt into a persistable
 * `AuctionExtraction`. `llm` is `null` when an LLM call was actually made and
 * failed (network/proxy error, or — for an LLM Batch API item — that
 * item's individual generation errored); pass a `ClampedExtraction` when it
 * succeeded. Do not call this at all when no LLM call was attempted (per-run
 * cap hit, LLM disabled, or a batch job still pending) — that path caches the
 * rules-only result directly, unrelated to this merge.
 */
export function mergeLlmResult(
  priorEntry: AuctionExtraction | undefined,
  fields: MergeInputFields,
  llm: ClampedExtraction | null,
  at: string,
  photos: CuratedPhoto[] | undefined,
): AuctionExtraction {
  const base = fields

  let source: 'rules' | 'llm' = 'rules'
  let propertyType = base.propertyType
  let landAreaSqm = base.landAreaSqm
  let livingAreaSqm = base.livingAreaSqm
  let rooms = base.rooms
  let bedrooms = base.bedrooms
  let bathrooms = base.bathrooms
  let floor = base.floor
  let bathroomHasTub = base.bathroomHasTub
  let bathroomHasShower = base.bathroomHasShower
  let heating = base.heating
  let units = base.units
  let securityDeposit = base.securityDeposit
  let biddingNotes = base.biddingNotes
  let condition = base.condition
  let features = base.features
  let yearBuilt = base.yearBuilt
  let lastRenovationYear = base.lastRenovationYear
  let renovationNotes = base.renovationNotes
  let insights = base.insights
  let planningNotes = base.planningNotes
  let documentSummary = base.documentSummary
  let marketValueEur = base.marketValueEur
  let marketValueText = base.marketValueText

  if (llm) {
    // propertyType keeps the 'sonstiges' == "nothing real found" nuance the
    // other three fields don't have.
    const ruleHasType = propertyType != null && propertyType !== 'sonstiges'
    let usedLlmForCoreFields = false
    if (!ruleHasType) {
      propertyType = llm.propertyType
      if (llm.propertyType != null) usedLlmForCoreFields = true
    } else if (llm.ruleCheck?.propertyType === false) {
      propertyType = llm.propertyType
      usedLlmForCoreFields = true
    }

    const roomsResolved = resolveVerifiedField(rooms, llm.rooms, llm.ruleCheck?.rooms)
    rooms = roomsResolved.value
    if (roomsResolved.usedLlm) usedLlmForCoreFields = true

    const unitsResolved = resolveVerifiedField(units, llm.units, llm.ruleCheck?.units)
    units = unitsResolved.value
    if (unitsResolved.usedLlm) usedLlmForCoreFields = true

    const securityDepositResolved = resolveVerifiedField(securityDeposit, llm.securityDeposit, llm.ruleCheck?.securityDeposit)
    securityDeposit = securityDepositResolved.value
    if (securityDepositResolved.usedLlm) usedLlmForCoreFields = true

    if (usedLlmForCoreFields) source = 'llm'

    landAreaSqm = landAreaSqm ?? llm.landAreaSqm
    livingAreaSqm = livingAreaSqm ?? llm.livingAreaSqm
    bedrooms = llm.bedrooms
    bathrooms = llm.bathrooms
    floor = llm.floor
    bathroomHasTub = llm.bathroomHasTub
    bathroomHasShower = llm.bathroomHasShower
    heating = llm.heating
    biddingNotes = llm.biddingNotes
    condition = llm.condition
    features = llm.features
    yearBuilt = llm.yearBuilt
    lastRenovationYear = llm.lastRenovationYear
    renovationNotes = llm.renovationNotes
    insights = llm.insights
    planningNotes = llm.planningNotes
    documentSummary = llm.documentSummary
    marketValueEur = llm.marketValueEur
    marketValueText = llm.marketValueText
  }

  const hasType = propertyType != null && propertyType !== 'sonstiges'
  const hasArea = landAreaSqm != null || livingAreaSqm != null
  return withDerivedExtractionFields({
    propertyType,
    landAreaSqm,
    livingAreaSqm,
    rooms,
    bedrooms,
    bathrooms,
    floor,
    bathroomHasTub,
    bathroomHasShower,
    heating,
    units,
    securityDeposit,
    biddingNotes,
    condition,
    features,
    yearBuilt,
    lastRenovationYear,
    renovationNotes,
    insights,
    planningNotes,
    documentSummary,
    marketValueEur,
    marketValueText,
    source,
    confidence: hasType && hasArea ? 'high' : 'low',
    photos,
    at,
    ...(llm
      ? { llmAnalyzedAt: at }
      : priorEntry?.llmAnalyzedAt
        ? { llmAnalyzedAt: priorEntry.llmAnalyzedAt }
        : {}),
  })
}
