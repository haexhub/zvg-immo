<script setup lang="ts">
import type { AuctionSummary } from '~/server/api/auctions.get'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import { auctionKey } from '~/lib/auction-key'

const props = defineProps<{
  auctions: AuctionSummary[]
  totalCount: number
  canLoadMore: boolean
  pending: boolean
  loggedIn: boolean
  watchlistIds: Map<string, string>
  activeAuctionKey?: string | null
  scrollTargetKey?: string | null
  geoAuctions: GeoAuction[]
  selectedCountries: string[]
  geoFitKey: string
  initialMapView?: { lat: number; lng: number; zoom: number } | null
  geoPending: boolean
  geoData: GeoCrawlResult | null
  geoError?: { statusMessage?: string; message?: string } | null
}>()

const emit = defineEmits<{
  (e: 'toggle-watchlist', auction: AuctionSummary): void
  (e: 'load-more'): void
  (e: 'bounds-change', bounds: { north: number; south: number; east: number; west: number }): void
  (e: 'view-change', view: { lat: number; lng: number; zoom: number }): void
  (e: 'auction-hover', key: string | null): void
  (e: 'auction-select', key: string): void
}>()

const activeTab = defineModel<'list' | 'map'>({ required: true })

const auctionSummaries = computed(() => new Map(props.auctions.map((a) => [auctionKey(a), a])))
</script>

<template>
  <Tabs v-model="activeTab" class="h-full flex flex-col gap-2">
    <TabsList class="self-stretch">
      <TabsTrigger value="list" class="flex-1">{{ $t('search.tabAuctions') }}</TabsTrigger>
      <TabsTrigger value="map" class="flex-1">{{ $t('search.tabMap') }}</TabsTrigger>
    </TabsList>
    <TabsContent value="list" class="flex-1 min-h-0">
      <AuctionListPane
        :auctions="auctions"
        :total-count="totalCount"
        :can-load-more="canLoadMore"
        :pending="pending"
        :logged-in="loggedIn"
        :watchlist-ids="watchlistIds"
        :active-auction-key="activeAuctionKey"
        :scroll-target-key="scrollTargetKey"
        @toggle-watchlist="emit('toggle-watchlist', $event)"
        @load-more="emit('load-more')"
        @auction-hover="emit('auction-hover', $event)"
      />
    </TabsContent>
    <TabsContent value="map" class="flex-1 min-h-0">
      <AuctionMapPane
        :auctions="geoAuctions"
        :auction-summaries="auctionSummaries"
        :selected-countries="selectedCountries"
        :active-auction-key="activeAuctionKey"
        :fit-key="geoFitKey"
        :initial-view="initialMapView"
        :geo-pending="geoPending"
        :has-geo-data="!!geoData"
        :geo-error="geoError"
        @bounds-change="emit('bounds-change', $event)"
        @view-change="emit('view-change', $event)"
        @auction-hover="emit('auction-hover', $event)"
        @auction-select="emit('auction-select', $event)"
      />
    </TabsContent>
  </Tabs>
</template>
