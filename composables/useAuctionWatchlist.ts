import type { AuctionSummary } from '~/server/api/auctions.get'
import type { WatchlistItem } from '~/server/api/watchlist/index.get'
import { apiErrorMessage } from '~/lib/api-error'
import { auctionKey } from '~/lib/auction-key'

export function useAuctionWatchlist(options: {
  onError?: (message: string) => void
} = {}) {
  const { user } = useAuth()
  const watchlistIds = ref<Map<string, string>>(new Map())

  async function loadWatchlist(): Promise<void> {
    if (!user.value) {
      watchlistIds.value = new Map()
      return
    }
    try {
      const items = await authFetch<WatchlistItem[]>('/api/watchlist')
      watchlistIds.value = new Map(items.map((item) => [auctionKey(item), item.id]))
    } catch (err) {
      options.onError?.(apiErrorMessage(err, 'Die Merkliste konnte nicht geladen werden.'))
    }
  }

  async function toggleWatchlist(auction: AuctionSummary): Promise<void> {
    if (!user.value) return
    const key = auctionKey(auction)
    const existingId = watchlistIds.value.get(key)
    try {
      if (existingId) {
        await authFetch(`/api/watchlist/${existingId}`, { method: 'DELETE' })
        const next = new Map(watchlistIds.value)
        next.delete(key)
        watchlistIds.value = next
      } else {
        const item = await authFetch<WatchlistItem>('/api/watchlist', {
          method: 'POST',
          body: {
            platform: auction.platform,
            externalId: auction.externalId,
            authority: auction.authority,
            caseNumber: auction.caseNumber,
          },
        })
        const next = new Map(watchlistIds.value)
        next.set(key, item.id)
        watchlistIds.value = next
      }
    } catch (err) {
      options.onError?.(apiErrorMessage(err, 'Die Merkliste konnte nicht geändert werden.'))
    }
  }

  watch(user, () => loadWatchlist(), { immediate: true })

  return {
    watchlistIds,
    loadWatchlist,
    toggleWatchlist,
  }
}
