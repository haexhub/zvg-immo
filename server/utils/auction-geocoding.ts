import type { Auction } from '~/types/auction'
import { geocodeAddress } from './geocode'

export interface FillAuctionGeocodesOptions {
  fetchMissing?: boolean
}

export interface FillAuctionGeocodesResult {
  processed: number
  geocoded: number
  failed: number
}

/**
 * Fills missing auction coordinates from the geocode cache/backend.
 * Existing crawler-provided coordinates remain authoritative.
 */
export async function fillAuctionGeocodes(
  auctions: Auction[],
  options: FillAuctionGeocodesOptions = {},
): Promise<FillAuctionGeocodesResult> {
  let processed = 0
  let geocoded = 0
  let failed = 0

  for (const auction of auctions) {
    if (!auction.address || (auction.lat != null && auction.lng != null)) continue
    processed++
    try {
      const point = await geocodeAddress(auction.address, auction.country, {
        fetchMissing: options.fetchMissing ?? false,
      })
      if (!point) continue
      auction.lat = point.lat
      auction.lng = point.lng
      geocoded++
    } catch {
      failed++
    }
  }

  return { processed, geocoded, failed }
}
