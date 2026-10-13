import type { Auction } from '~/types/auction'
import type { LocationEnrichmentCache } from '~/server/utils/external-data/location-enrichment'
import { cacheKey } from '~/server/utils/verkehrswert-cache'

export interface ScopeOptions {
  country?: string
  platform?: string
  externalId?: string
}

export function inScope(auction: Auction, options: ScopeOptions): boolean {
  if (options.country && auction.country.toLowerCase() !== options.country.trim().toLowerCase()) return false
  if (options.platform && auction.platform !== options.platform) return false
  if (options.externalId && auction.externalId !== options.externalId) return false
  return true
}

// Oldest-checked-first, never-checked before everything else: a batch that
// gets superseded (runExclusiveTask) before finishing only costs that
// batch's still-unprocessed tail — the same overdue auctions sort back to
// the front on the very next run instead of a fixed scan order letting
// whatever sits late in the list starve indefinitely.
export function orderByStaleness(auctions: Auction[], existing: LocationEnrichmentCache): Auction[] {
  return [...auctions].sort((a, b) => {
    const aChecked = existing[cacheKey(a.platform, a.externalId)]?.checkedAt ?? ''
    const bChecked = existing[cacheKey(b.platform, b.externalId)]?.checkedAt ?? ''
    return aChecked < bChecked ? -1 : aChecked > bChecked ? 1 : 0
  })
}
