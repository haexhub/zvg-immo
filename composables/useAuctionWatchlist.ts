import type { WatchlistItem } from '~/server/api/watchlist/index.get'
import { apiErrorMessage } from '~/lib/api-error'
import { auctionKey } from '~/lib/auction-key'

export interface WatchlistableAuction {
  platform: string
  externalId: string
  authority: string
  caseNumber: string
}

export function useAuctionWatchlist(options: {
  onError?: (message: string) => void
} = {}) {
  const { user } = useAuth()
  const { t } = useI18n()
  const route = useRoute()
  const watchlistIds = ref<Map<string, string>>(new Map())
  const pendingKeys = new Set<string>()

  async function loadWatchlist(): Promise<void> {
    if (!user.value) {
      watchlistIds.value = new Map()
      return
    }
    try {
      const items = await authFetch<WatchlistItem[]>('/api/watchlist')
      watchlistIds.value = new Map(items.map((item) => [auctionKey(item), item.id]))
    } catch (err) {
      options.onError?.(apiErrorMessage(err, t('account.watchlist.loadError')))
    }
  }

  async function toggleWatchlist(auction: WatchlistableAuction): Promise<void> {
    // The heart stays visible while logged out (e.g. after the session
    // expired), so a click leads to the login instead of doing nothing.
    if (!user.value) {
      await navigateTo(`/login?redirect=${encodeURIComponent(route.fullPath)}`)
      return
    }
    const key = auctionKey(auction)
    if (pendingKeys.has(key)) return
    pendingKeys.add(key)
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
      options.onError?.(apiErrorMessage(err, t('account.watchlist.updateError')))
    } finally {
      pendingKeys.delete(key)
    }
  }

  watch(user, () => loadWatchlist(), { immediate: true })

  return {
    watchlistIds,
    loadWatchlist,
    toggleWatchlist,
  }
}
