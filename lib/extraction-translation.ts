import type { Auction, AuctionExtraction, AuctionInsights, LandParcel, PlanningNotes } from '~/types/auction'

export const TRANSLATABLE_EXTRACTION_TEXTS_VERSION = 3

export interface TranslatableInsightsTexts {
  defects: string[]
  encumbrances: string[]
  construction: string | null
  locationCharacter: string | null
  summary: string | null
}

export interface TranslatableLandParcelTexts {
  label: string | null
  use: string | null
}

export interface TranslatablePlanningNotesTexts {
  monumentProtection: string | null
  contamination: string | null
  developmentPlan: string | null
  landConsolidation: string | null
  developmentCharges: string | null
  redevelopmentArea: string | null
  conservationArea: string | null
  landParcels: TranslatableLandParcelTexts[]
}

export interface TranslatableExtractionTexts {
  biddingNotes: string | null
  renovationNotes: string | null
  floor: string | null
  heating: string | null
  insights: TranslatableInsightsTexts | null
  planningNotes: TranslatablePlanningNotesTexts | null
}

export interface TranslationContentSource {
  title: string | null
  address: string | null
  description: string | null
  documentSummary: string | null
  extractionTexts: TranslatableExtractionTexts | null
  extractionTextsVersion: number
  documentSetHash: string | null
  documentSetVersion: number | null
}

function text(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function texts(values: string[] | null | undefined): string[] {
  return (values ?? []).map((value) => text(value)).filter((value): value is string => value != null)
}

function hasInsightsTexts(insights: TranslatableInsightsTexts): boolean {
  return insights.defects.length > 0 ||
    insights.encumbrances.length > 0 ||
    insights.construction != null ||
    insights.locationCharacter != null ||
    insights.summary != null
}

function extractInsightsTexts(insights: AuctionInsights | null | undefined): TranslatableInsightsTexts | null {
  if (!insights) return null
  const out: TranslatableInsightsTexts = {
    defects: texts(insights.defects),
    encumbrances: texts(insights.encumbrances),
    construction: text(insights.construction),
    locationCharacter: text(insights.locationCharacter),
    summary: text(insights.summary),
  }
  return hasInsightsTexts(out) ? out : null
}

function extractLandParcelTexts(parcel: LandParcel): TranslatableLandParcelTexts {
  return {
    label: text(parcel.label),
    use: text(parcel.use),
  }
}

function hasPlanningNotesTexts(notes: TranslatablePlanningNotesTexts): boolean {
  return notes.monumentProtection != null ||
    notes.contamination != null ||
    notes.developmentPlan != null ||
    notes.landConsolidation != null ||
    notes.developmentCharges != null ||
    notes.redevelopmentArea != null ||
    notes.conservationArea != null ||
    notes.landParcels.some((parcel) => parcel.label != null || parcel.use != null)
}

function extractPlanningNotesTexts(notes: PlanningNotes | null | undefined): TranslatablePlanningNotesTexts | null {
  if (!notes) return null
  const out: TranslatablePlanningNotesTexts = {
    monumentProtection: text(notes.monumentProtection),
    contamination: text(notes.contamination),
    developmentPlan: text(notes.developmentPlan),
    landConsolidation: text(notes.landConsolidation),
    developmentCharges: text(notes.developmentCharges),
    redevelopmentArea: text(notes.redevelopmentArea),
    conservationArea: text(notes.conservationArea),
    landParcels: (notes.landParcels ?? []).map(extractLandParcelTexts),
  }
  return hasPlanningNotesTexts(out) ? out : null
}

export function extractTranslatableExtractionTexts(
  extraction: AuctionExtraction | null | undefined,
): TranslatableExtractionTexts | null {
  if (!extraction) return null
  const out: TranslatableExtractionTexts = {
    biddingNotes: text(extraction.biddingNotes),
    renovationNotes: text(extraction.renovationNotes),
    floor: text(extraction.floor),
    heating: text(extraction.heating),
    insights: extractInsightsTexts(extraction.insights),
    planningNotes: extractPlanningNotesTexts(extraction.planningNotes),
  }
  return out.biddingNotes != null ||
    out.renovationNotes != null ||
    out.floor != null ||
    out.heating != null ||
    out.insights != null ||
    out.planningNotes != null
    ? out
    : null
}

export function translationContentSource(
  auction: Pick<Auction, 'title' | 'address' | 'description' | 'extraction'>,
): TranslationContentSource {
  return {
    title: auction.title,
    address: auction.address,
    description: auction.description,
    documentSummary: auction.extraction?.documentSummary ?? null,
    extractionTexts: extractTranslatableExtractionTexts(auction.extraction),
    extractionTextsVersion: TRANSLATABLE_EXTRACTION_TEXTS_VERSION,
    documentSetHash: auction.extraction?.documentSetHash ?? null,
    documentSetVersion: auction.extraction?.documentSetVersion ?? null,
  }
}

export function applyTranslatedExtractionTexts(
  extraction: AuctionExtraction | null | undefined,
  texts: TranslatableExtractionTexts | null | undefined,
): AuctionExtraction | null | undefined {
  if (!extraction || !texts) return extraction
  return {
    ...extraction,
    biddingNotes: texts.biddingNotes ?? extraction.biddingNotes,
    renovationNotes: texts.renovationNotes ?? extraction.renovationNotes,
    floor: texts.floor ?? extraction.floor,
    heating: texts.heating ?? extraction.heating,
    insights: extraction.insights && texts.insights
      ? {
          ...extraction.insights,
          defects: texts.insights.defects,
          encumbrances: texts.insights.encumbrances,
          construction: texts.insights.construction ?? extraction.insights.construction,
          locationCharacter: texts.insights.locationCharacter ?? extraction.insights.locationCharacter,
          summary: texts.insights.summary ?? extraction.insights.summary,
        }
      : extraction.insights,
    planningNotes: extraction.planningNotes && texts.planningNotes
      ? {
          ...extraction.planningNotes,
          monumentProtection: texts.planningNotes.monumentProtection ?? extraction.planningNotes.monumentProtection,
          contamination: texts.planningNotes.contamination ?? extraction.planningNotes.contamination,
          developmentPlan: texts.planningNotes.developmentPlan ?? extraction.planningNotes.developmentPlan,
          landConsolidation: texts.planningNotes.landConsolidation ?? extraction.planningNotes.landConsolidation,
          developmentCharges: texts.planningNotes.developmentCharges ?? extraction.planningNotes.developmentCharges,
          redevelopmentArea: texts.planningNotes.redevelopmentArea ?? extraction.planningNotes.redevelopmentArea,
          conservationArea: texts.planningNotes.conservationArea ?? extraction.planningNotes.conservationArea,
          landParcels: extraction.planningNotes.landParcels.map((parcel, i) => ({
            ...parcel,
            label: texts.planningNotes?.landParcels[i]?.label ?? parcel.label,
            use: texts.planningNotes?.landParcels[i]?.use ?? parcel.use,
          })),
        }
      : extraction.planningNotes,
  }
}
