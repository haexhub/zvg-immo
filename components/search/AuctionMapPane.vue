<script setup lang="ts">
import type { GeoAuction } from '~/server/api/auctions-geo.get'

defineProps<{
  auctions: GeoAuction[]
  fitKey: string
  geoPending: boolean
  hasGeoData: boolean
  geoError?: { statusMessage?: string; message?: string } | null
}>()
</script>

<template>
  <div class="relative h-full flex flex-col">
    <p v-if="geoError" class="py-12 text-center text-destructive">
      {{ $t('search.geoError', { msg: geoError.statusMessage || geoError.message }) }}
    </p>
    <template v-else>
      <!-- Mount immediately so tiles render right away; markers stream in
           as geoData arrives instead of gating the whole map behind it. -->
      <AuctionMap :auctions="auctions" :fit-key="fitKey" />
      <p
        v-if="geoPending && !hasGeoData"
        class="absolute top-3 left-1/2 -translate-x-1/2 rounded-md border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm"
      >
        {{ $t('search.loadingLocations') }}
      </p>
    </template>
  </div>
</template>
