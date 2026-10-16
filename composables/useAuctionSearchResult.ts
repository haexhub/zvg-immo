import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { AuctionSearchResponse } from '~/server/api/auctions.get'

// The main /api/auctions fetch used to live entirely in pages/search.vue.
// It now lives in layouts/search.vue instead, alongside useAuctionSearchState,
// because the header's Properties popover (courts/categories dropdowns) needs
// the same facet data the results list does — and a layout is the only
// common ancestor of "always-visible header" and "page content" (see
// useAuctionSearchState.ts's own comment on AUCTION_SEARCH_STATE_KEY).
export interface AuctionSearchResult {
  data: Ref<AuctionSearchResponse | null>
  pending: Ref<boolean>
  error: Ref<{ statusMessage?: string; message?: string } | null | undefined>
  refresh: () => Promise<void>
  courts: ComputedRef<string[]>
  categories: ComputedRef<Array<{ id: string; label: string; count: number }>>
}
export const AUCTION_SEARCH_RESULT_KEY: InjectionKey<AuctionSearchResult> = Symbol('auctionSearchResult')
