// Last-resort privacy guard for data that leaves the service. Source portals
// and archived artefacts may legitimately contain personal data, but a public
// property listing must not republish names of debtors or other affected
// natural persons. Keep this at the HTTP boundary as well as in the LLM
// prompt: prompts reduce new incidents, whereas this guard also covers old
// extractions and cached translations.

import type { Auction, AuctionExtraction, AuctionInsights, PlanningNotes } from '~/types/auction'

const REDACTED_PERSON = '[anonymisiert]'

// The pattern deliberately requires a role that can identify an affected
// natural person. Property addresses, place names and named companies must
// remain useful, so this is not a broad (and unreliable) named-entity filter.
const AFFECTED_PERSON_ROLE = [
  'Schuldner(?:in|innen|s|n)?',
  'Vollstreckungsschuldner(?:in|innen|s|n)?',
  'Insolvenzschuldner(?:in|innen|s|n)?',
  'Betreibungsschuldner(?:in|innen|s|n)?',
  'Antragsgegner(?:in|innen|s|n)?',
  'Verpflichtete(?:r|n|m|s)?',
  'Miteigentümer(?:in|innen|s|n)?',
  'Eigentümer(?:in|innen|s|n)?',
  'debtor(?:s)?',
  'respondent(?:s)?',
  'co-owner(?:s)?',
  'owner(?:s)?',
].join('|')

// A full name, initial plus surname, or titled surname. Requiring a surname
// (rather than accepting a single capitalised word) avoids treating ordinary
// German prose following a role as a person's name.
const NAME_WORD = String.raw`[A-ZÀ-ÖØ-Þ][\p{Ll}À-ÖØ-öø-ÿ'’-]+`
const NAME_PART = String.raw`(?:(?:von|van|de|der|den|ten)[ \t]+)?${NAME_WORD}`
const PERSON_NAME = String.raw`(?:(?:Herrn?|Frau|Mr\.?|Mrs\.?|Ms\.?)[ \t]+)?(?:[A-ZÀ-ÖØ-Þ]\.[ \t]+${NAME_WORD}|(?:Dr\.?|Prof\.?)[ \t]+${NAME_WORD}|${NAME_WORD}(?:[ \t]+${NAME_PART}){1,3})`

const roleThenName = new RegExp(String.raw`\b(${AFFECTED_PERSON_ROLE})[ \t]+${PERSON_NAME}`, 'gu')
const labelledRoleThenName = new RegExp(String.raw`\b(${AFFECTED_PERSON_ROLE})[ \t]*:[ \t]*${PERSON_NAME}`, 'gu')
const nameBeforeRole = new RegExp(
  String.raw`\b${PERSON_NAME}(?=\s*,?\s*(?:als\s+)?(?:${AFFECTED_PERSON_ROLE})\b)`,
  'gu',
)
// Some announcements only say "Insolvenzverfahren über das Vermögen von
// Vorname Nachname". In that legal context the named person is equally
// sensitive even if no role is repeated next to the name.
const insolvencyName = new RegExp(
  String.raw`\b((?:Insolvenzverfahren|Schuldenbereinigungsverfahren|Restschuldbefreiung|bankruptcy)[^\n.]{0,120}?\b(?:über\s+(?:das\s+Vermögen\s+)?(?:von\s+)?|against\s+|von\s+|des\s+|der\s+))${PERSON_NAME}`,
  'giu',
)

/** Replaces names only when their surrounding legal role makes them sensitive. */
export function redactAffectedPersonNames(value: string | null | undefined): string | null | undefined {
  if (value == null) return value
  return value
    .replace(labelledRoleThenName, `$1: ${REDACTED_PERSON}`)
    .replace(roleThenName, `$1 ${REDACTED_PERSON}`)
    .replace(nameBeforeRole, REDACTED_PERSON)
    .replace(insolvencyName, `$1${REDACTED_PERSON}`)
}

export interface PublicAuctionRedaction {
  auction: Auction
  /** True when the response carried sensitive personal data before redaction. */
  redacted: boolean
}

/**
 * Produces the display-safe auction projection. If one of its visible texts
 * needed redaction, the original documents and source links remain intact.
 * They are the required source attribution and are not our own publication.
 */
export function redactAuctionForPublication(auction: Auction): PublicAuctionRedaction {
  let redacted = false
  const text = <T extends string | null | undefined>(value: T): T => {
    const next = redactAffectedPersonNames(value)
    if (next !== value) redacted = true
    return next as T
  }
  const insights = redactInsights(auction.extraction?.insights, text)
  const planningNotes = redactPlanningNotes(auction.extraction?.planningNotes, text)
  const extraction: AuctionExtraction | undefined = auction.extraction
    ? {
        ...auction.extraction,
        biddingNotes: text(auction.extraction.biddingNotes),
        renovationNotes: text(auction.extraction.renovationNotes),
        floor: text(auction.extraction.floor),
        heating: text(auction.extraction.heating),
        marketValueText: text(auction.extraction.marketValueText),
        documentSummary: text(auction.extraction.documentSummary),
        insights,
        planningNotes,
        photos: auction.extraction.photos?.map((photo) => ({ ...photo, caption: text(photo.caption) })),
      }
    : undefined
  const publicAuction: Auction = {
    ...auction,
    title: text(auction.title),
    address: text(auction.address),
    description: text(auction.description),
    marketValueText: text(auction.marketValueText),
    attachments: auction.attachments.map((attachment) => ({
      ...attachment,
      label: text(attachment.label),
    })),
    photoUrls: auction.photoUrls ? [...auction.photoUrls] : undefined,
    extraction,
  }

  return { auction: publicAuction, redacted }
}

function redactInsights(
  insights: AuctionInsights | null | undefined,
  text: <T extends string | null | undefined>(value: T) => T,
): AuctionInsights | null | undefined {
  if (!insights) return insights
  return {
    ...insights,
    defects: insights.defects.map(text),
    encumbrances: insights.encumbrances.map(text),
    construction: text(insights.construction),
    locationCharacter: text(insights.locationCharacter),
    summary: text(insights.summary),
  }
}

function redactPlanningNotes(
  notes: PlanningNotes | null | undefined,
  text: <T extends string | null | undefined>(value: T) => T,
): PlanningNotes | null | undefined {
  if (!notes) return notes
  return {
    ...notes,
    monumentProtection: text(notes.monumentProtection),
    contamination: text(notes.contamination),
    developmentPlan: text(notes.developmentPlan),
    landConsolidation: text(notes.landConsolidation),
    developmentCharges: text(notes.developmentCharges),
    redevelopmentArea: text(notes.redevelopmentArea),
    conservationArea: text(notes.conservationArea),
    landParcels: notes.landParcels.map((parcel) => ({
      ...parcel,
      label: text(parcel.label)!,
      use: text(parcel.use),
    })),
  }
}
