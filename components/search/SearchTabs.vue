<script setup lang="ts">
import type { Auction } from '~/types/auction'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'

defineProps<{
  auctions: Auction[]
  totalCount: number
  pending: boolean
  loggedIn: boolean
  watchlistIds: Map<string, string>
  geoAuctions: GeoAuction[]
  geoFitKey: string
  geoPending: boolean
  geoData: GeoCrawlResult | null
  geoError?: { statusMessage?: string; message?: string } | null
}>()

const emit = defineEmits<{
  (e: 'toggle-watchlist', auction: Auction): void
  (e: 'load-more'): void
}>()

const activeTab = defineModel<'list' | 'map'>({ required: true })
</script>

<template>
  <Tabs v-model="activeTab" class="h-full flex flex-col gap-2">
    <TabsList class="self-stretch">
      <TabsTrigger value="list" class="flex-1">{{ $t('search.tabAuctions') }}</TabsTrigger>
      <TabsTrigger value="map" class="flex-1">{{ $t('search.tabMap') }}</TabsTrigger>
    </TabsList>
    <TabsContent value="list" class="flex-1 min-h-0">
      <SearchAuctionListPane
        :auctions="auctions"
        :total-count="totalCount"
        :pending="pending"
        :logged-in="loggedIn"
        :watchlist-ids="watchlistIds"
        @toggle-watchlist="emit('toggle-watchlist', $event)"
        @load-more="emit('load-more')"
      />
    </TabsContent>
    <TabsContent value="map" class="flex-1 min-h-0">
      <SearchAuctionMapPane
        :auctions="geoAuctions"
        :fit-key="geoFitKey"
        :geo-pending="geoPending"
        :has-geo-data="!!geoData"
        :geo-error="geoError"
      />
    </TabsContent>
  </Tabs>
</template>
