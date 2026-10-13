import type { Auction } from '~/types/auction'
import { normalizeAuctionDescription } from './description-normalization'
import { storedEurConversion } from './exchange-rate'

/**
 * Keeps detail-only values when a cheap list crawl returns a partial auction.
 * Mutable fields such as currentBid deliberately remain authoritative on next.
 */
export function mergeStoredAuction(next: Auction, previous: Auction): Auction {
  normalizeAuctionDescription(next)
  const normalizedPrevious = { ...previous }
  normalizeAuctionDescription(normalizedPrevious)
  const previousDescription = normalizedPrevious.description
  if (next.attachments.length === 0 && previous.attachments.length > 0) next.attachments = previous.attachments
  if (next.description == null && previousDescription != null) {
    next.description = previousDescription
  } else if (
    next.description != null &&
    previousDescription != null &&
    previous.detailFetchedAt != null &&
    previousDescription.startsWith(next.description)
  ) {
    next.description = previousDescription
  }
  if (!next.caseNumber && previous.caseNumber) next.caseNumber = previous.caseNumber
  if (next.pdfUrl == null && previous.pdfUrl != null) {
    next.pdfUrl = previous.pdfUrl
    next.pdfUrlUpstream = previous.pdfUrlUpstream
  }
  if (next.detailUrl == null && previous.detailUrl != null) {
    next.detailUrl = previous.detailUrl
    next.detailUrlUpstream = previous.detailUrlUpstream
  }
  if (next.photoCount === 0 && previous.photoCount > 0) next.photoCount = previous.photoCount
  if (next.thumbnailUrl == null && previous.thumbnailUrl != null) next.thumbnailUrl = previous.thumbnailUrl
  if (
    next.marketValueEur == null &&
    next.marketValue == null &&
    (previous.marketValueEur != null || previous.marketValue != null)
  ) {
    next.marketValueEur = previous.marketValueEur
    next.marketValueText = previous.marketValueText
    next.marketValue = previous.marketValue ?? null
    next.currency = previous.currency ?? null
  } else if (next.marketValueEur == null && next.marketValue != null) {
    next.marketValueEur = storedEurConversion(next, previous)
  }
  if (next.detailFetchedAt == null && previous.detailFetchedAt != null) next.detailFetchedAt = previous.detailFetchedAt
  if (next.sourceLivingAreaSqm == null && previous.sourceLivingAreaSqm != null) next.sourceLivingAreaSqm = previous.sourceLivingAreaSqm
  if (next.sourceLandAreaSqm == null && previous.sourceLandAreaSqm != null) next.sourceLandAreaSqm = previous.sourceLandAreaSqm
  if (next.sourceRooms == null && previous.sourceRooms != null) next.sourceRooms = previous.sourceRooms
  if (next.startingBid == null && previous.startingBid != null) next.startingBid = previous.startingBid
  if (next.sourceSecurityDeposit == null && previous.sourceSecurityDeposit != null) {
    next.sourceSecurityDeposit = previous.sourceSecurityDeposit
  }
  if ((next.photoUrls == null || next.photoUrls.length === 0) && previous.photoUrls?.length) {
    next.photoUrls = previous.photoUrls
    next.photoCount = Math.max(next.photoCount, previous.photoUrls.length)
  }
  // Several list endpoints only expose a coarse address (KIP: postal code +
  // city, BOE: "CP Ort, España") that the detail page later replaces with the
  // full one. Once details were fetched the stored address wins, together
  // with its coordinates: a list-row point is often just a geocode of that
  // coarse address and would move the pin to e.g. a postal-code centroid.
  // A source that withholds the location (coordinatesWithheld) hides the
  // address too, so neither is restored for it.
  if (
    !next.coordinatesWithheld &&
    previous.detailFetchedAt != null &&
    previous.address != null &&
    next.address !== previous.address
  ) {
    next.address = previous.address
    if (previous.lat != null && previous.lng != null) {
      next.lat = previous.lat
      next.lng = previous.lng
    }
  }
  if (next.lat == null && !next.coordinatesWithheld && previous.lat != null && previous.lng != null) {
    next.lat = previous.lat
    next.lng = previous.lng
  }
  if (next.extraction == null && previous.extraction != null) next.extraction = previous.extraction
  return next
}
