import type { Auction } from '~/types/auction'
import { normalizeAuctionDescription } from './description-normalization'

/**
 * Keeps detail-only values when a cheap list crawl returns a partial auction.
 * Mutable fields such as currentBid deliberately remain authoritative on next.
 */
export function mergeStoredAuction(next: Auction, previous: Auction): Auction {
  normalizeAuctionDescription(next)
  normalizeAuctionDescription(previous)
  if (next.attachments.length === 0 && previous.attachments.length > 0) next.attachments = previous.attachments
  if (next.description == null && previous.description != null) {
    next.description = previous.description
  } else if (
    next.description != null &&
    previous.description != null &&
    previous.detailFetchedAt != null &&
    previous.description.startsWith(next.description)
  ) {
    next.description = previous.description
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
  if (next.lat == null && previous.lat != null && previous.lng != null) {
    next.lat = previous.lat
    next.lng = previous.lng
  }
  if (next.extraction == null && previous.extraction != null) next.extraction = previous.extraction
  return next
}
