import type { Auction } from '~/types/auction'
import { cacheKey } from '~/server/utils/verkehrswert-cache'

export interface ScopeOptions {
  country?: string
  platform?: string
  externalId?: string
}

export function inScope(auction: Pick<Auction, 'country' | 'platform' | 'externalId'>, options: ScopeOptions): boolean {
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
export function orderByStaleness<T extends { platform: string; externalId: string }>(
  auctions: T[],
  staleness: ReadonlyMap<string, { checkedAt?: string }>,
): T[] {
  return [...auctions].sort((a, b) => {
    const aChecked = staleness.get(cacheKey(a.platform, a.externalId))?.checkedAt ?? ''
    const bChecked = staleness.get(cacheKey(b.platform, b.externalId))?.checkedAt ?? ''
    return aChecked < bChecked ? -1 : aChecked > bChecked ? 1 : 0
  })
}
