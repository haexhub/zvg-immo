import type { Auction, AuctionExtraction } from '~/types/auction'
import { normalizePhoto, sortCuratedPhotos } from '~/lib/photo'
import { withDerivedExtractionFields } from './extract/merge-llm-result'

/** Applies one structured extraction to an auction and derives display photos. */
export function applyAuctionExtraction(
  auction: Auction,
  extraction: AuctionExtraction | null | undefined,
): Auction {
  if (!extraction) return auction
  const normalized = withDerivedExtractionFields(extraction)
  const seenFiles = new Set<string>()
  const photos = sortCuratedPhotos((normalized.photos ?? []).map(normalizePhoto)).filter((photo) => {
    if (seenFiles.has(photo.file)) return false
    seenFiles.add(photo.file)
    return true
  })

  auction.extraction = photos.length > 0 ? { ...normalized, photos } : normalized
  if (auction.currency == null && auction.marketValueEur == null && normalized.marketValueEur != null) {
    auction.marketValueEur = normalized.marketValueEur
    auction.marketValueText = normalized.marketValueText ?? null
  }
  if (photos.length > 0) {
    auction.thumbnailUrl = `/api/auction-image/${encodeURIComponent(auction.platform)}/${encodeURIComponent(auction.externalId)}/${encodeURIComponent(photos[0]!.file)}`
    auction.photoCount = photos.length
  } else if (normalized.photos != null) {
    // An explicit empty curated set supersedes photos from the prior detail version.
    auction.thumbnailUrl = null
    auction.photoCount = 0
  }
  return auction
}

export function applyAuctionExtractions(auctions: Auction[]): void {
  for (const auction of auctions) applyAuctionExtraction(auction, auction.extraction)
}
