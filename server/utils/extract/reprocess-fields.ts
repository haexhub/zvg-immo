import type { Auction, AuctionExtraction } from '~/types/auction'
import { extractByRules } from './rules'
import type { MergeInputFields } from './merge-llm-result'

type LlmOwnedFields = Omit<MergeInputFields, 'propertyType' | 'landAreaSqm' | 'livingAreaSqm' | 'rooms' | 'units' | 'securityDeposit'>

/** The extraction-owned fields only an LLM pass produces. Carried forward
 *  from the prior entry into a merge base that gets no LLM result. */
export function priorLlmFields(priorEntry: AuctionExtraction | undefined): LlmOwnedFields {
  return {
    biddingNotes: priorEntry?.biddingNotes,
    condition: priorEntry?.condition,
    features: priorEntry?.features,
    bedrooms: priorEntry?.bedrooms,
    bathrooms: priorEntry?.bathrooms,
    floor: priorEntry?.floor,
    bathroomHasTub: priorEntry?.bathroomHasTub,
    bathroomHasShower: priorEntry?.bathroomHasShower,
    heating: priorEntry?.heating,
    yearBuilt: priorEntry?.yearBuilt,
    lastRenovationYear: priorEntry?.lastRenovationYear,
    renovationNotes: priorEntry?.renovationNotes,
    insights: priorEntry?.insights,
    planningNotes: priorEntry?.planningNotes,
    documentSummary: priorEntry?.documentSummary,
    marketValueEur: priorEntry?.marketValueEur,
    marketValueText: priorEntry?.marketValueText,
  }
}

/** Builds the deterministic merge base shared by sync and batch reprocessing.
 *  With a changed document set the prior LLM values are left out, since the
 *  LLM result about to be merged replaces them; a caller that ends up with
 *  no LLM result re-adds them through priorLlmFields. */
export function buildReprocessFields(
  auction: Auction,
  priorEntry: AuctionExtraction | undefined,
  documentSetChanged: boolean,
): MergeInputFields {
  const rules = extractByRules({ title: auction.title, description: auction.description })
  return {
    propertyType: rules.propertyType,
    landAreaSqm: auction.sourceLandAreaSqm ?? rules.landAreaSqm,
    livingAreaSqm: auction.sourceLivingAreaSqm ?? rules.livingAreaSqm,
    rooms: auction.sourceRooms ?? rules.rooms,
    units: rules.units,
    securityDeposit: auction.sourceSecurityDeposit ?? rules.securityDeposit,
    ...priorLlmFields(documentSetChanged ? undefined : priorEntry),
  }
}
