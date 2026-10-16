<script setup lang="ts">
import { auctionKey } from '~/lib/auction-key'
import type { AuctionSummary } from '~/server/api/auctions.get'

const props = defineProps<{
  auctions: AuctionSummary[]
  totalCount: number
  canLoadMore: boolean
  pending: boolean
  loggedIn: boolean
  watchlistIds: Map<string, string>
  activeAuctionKey?: string | null
  scrollTargetKey?: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle-watchlist', auction: AuctionSummary): void
  (e: 'load-more'): void
  (e: 'auction-hover', key: string | null): void
}>()

function escapeSelectorValue(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

watch(() => props.scrollTargetKey, async (key) => {
  if (!key || !import.meta.client) return
  await nextTick()
  const el = document.querySelector(`[data-auction-key="${escapeSelectorValue(key)}"]`)
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})
</script>

<template>
  <div class="h-full overflow-y-auto p-1 pb-4">
    <p v-if="props.auctions.length === 0 && props.totalCount === 0 && !props.pending" class="py-12 text-center text-muted-foreground">
      {{ $t('search.noResults') }}
    </p>

    <ul
      v-if="props.pending && props.auctions.length === 0"
      class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]"
      aria-hidden="true"
    >
      <li v-for="i in 8" :key="i" class="h-full animate-pulse">
        <div class="aspect-16/10 rounded-2xl bg-muted" />
        <div class="flex flex-col gap-2 pt-3">
          <div class="h-4 w-4/5 rounded bg-muted" />
          <div class="h-3 w-1/3 rounded bg-muted" />
          <div class="h-4 w-1/2 rounded bg-muted" />
        </div>
      </li>
    </ul>

    <ul v-else-if="props.auctions.length" class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
      <li
        v-for="a in props.auctions"
        :key="auctionKey(a)"
        :data-auction-key="auctionKey(a)"
        @mouseenter="emit('auction-hover', auctionKey(a))"
        @mouseleave="emit('auction-hover', null)"
        @focusin="emit('auction-hover', auctionKey(a))"
        @focusout="emit('auction-hover', null)"
      >
        <AuctionCard
          :auction="a"
          :logged-in="props.loggedIn"
          :in-watchlist="props.watchlistIds.has(auctionKey(a))"
          :active="auctionKey(a) === props.activeAuctionKey"
          class="h-full"
          @toggle-watchlist="emit('toggle-watchlist', a)"
        />
      </li>
    </ul>

    <div v-if="props.canLoadMore" class="flex flex-col items-center gap-2 pt-2 pb-4">
      <p class="text-xs text-muted-foreground">{{ $t('search.loadMoreShown', { shown: props.auctions.length, total: props.totalCount }) }}</p>
      <Button type="button" variant="outline" @click="emit('load-more')">
        {{ $t('search.loadMore') }}
      </Button>
    </div>
  </div>
</template>
