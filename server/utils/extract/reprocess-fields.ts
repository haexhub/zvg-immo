import type { Auction, AuctionExtraction } from '~/types/auction'
import { extractByRules } from './rules'
import type { MergeInputFields } from './merge-llm-result'

/** Builds the deterministic merge base shared by sync and batch reprocessing. */
export function buildReprocessFields(
  auction: Auction,
  priorEntry: AuctionExtraction | undefined,
  documentSetChanged: boolean,
): MergeInputFields {
  const effectivePriorEntry = documentSetChanged ? undefined : priorEntry
  const rules = extractByRules({ title: auction.title, description: auction.description })
  const propertyType = rules.propertyType
  const landAreaSqm = auction.sourceLandAreaSqm ?? rules.landAreaSqm
  const livingAreaSqm = auction.sourceLivingAreaSqm ?? rules.livingAreaSqm
  return {
    propertyType,
    landAreaSqm,
    livingAreaSqm,
    rooms: auction.sourceRooms ?? rules.rooms,
    units: rules.units,
    securityDeposit: auction.sourceSecurityDeposit ?? rules.securityDeposit,
    condition: effectivePriorEntry?.condition,
    features: effectivePriorEntry?.features,
    bedrooms: effectivePriorEntry?.bedrooms,
    bathrooms: effectivePriorEntry?.bathrooms,
    floor: effectivePriorEntry?.floor,
    bathroomHasTub: effectivePriorEntry?.bathroomHasTub,
    bathroomHasShower: effectivePriorEntry?.bathroomHasShower,
    heating: effectivePriorEntry?.heating,
    yearBuilt: effectivePriorEntry?.yearBuilt,
    lastRenovationYear: effectivePriorEntry?.lastRenovationYear,
    renovationNotes: effectivePriorEntry?.renovationNotes,
    insights: effectivePriorEntry?.insights,
    planningNotes: effectivePriorEntry?.planningNotes,
    documentSummary: effectivePriorEntry?.documentSummary,
    marketValueEur: effectivePriorEntry?.marketValueEur,
    marketValueText: effectivePriorEntry?.marketValueText,
  }
}
