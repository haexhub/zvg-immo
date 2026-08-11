<script setup lang="ts">
import type { LandingRailsResponse } from '~/server/api/landing/rails.get'

// The search bar lives in the header, which layouts/landing.vue owns together
// with its filter state.
definePageMeta({ layout: 'landing' })

const { t } = useI18n()

// app.vue already sets the reactive title/description from these same
// site.* keys; this adds the Open Graph/canonical tags it doesn't cover.
const canonicalUrl = useRequestURL().origin
useSeoMeta({
  ogTitle: () => t('site.title'),
  ogDescription: () => t('site.description'),
  ogType: 'website',
  ogUrl: canonicalUrl,
  twitterCard: 'summary',
})
useHead({ link: [{ rel: 'canonical', href: canonicalUrl }] })

const { data: rails } = await useFetch<LandingRailsResponse | null>('/api/landing/rails', {
  cache: 'no-store',
  default: () => null,
})

// Radii in km, matching the meter cutoffs rails.get.ts's GEO_CATEGORIES
// queries auction_geo_metrics with (5000/15000/5000/2000m) — keeps the "show
// all" link's search-page results consistent with what's actually in the rail.
const GEO_RAIL_QUERY: Record<'sea' | 'mountains' | 'lakes' | 'rivers', Record<string, string>> = {
  sea: { nearSea: '5' },
  mountains: { nearMountain: '15' },
  lakes: { nearLake: '5' },
  rivers: { nearRiver: '2' },
}
const geoRails = computed(() => {
  if (!rails.value) return []
  return (['sea', 'mountains', 'lakes', 'rivers'] as const)
    .map((key) => ({ key, items: rails.value![key], query: GEO_RAIL_QUERY[key] }))
    .filter((geo) => geo.items.length > 0)
})
</script>

<template>
  <main>
    <!-- Category rails -->
    <div class="w-full px-3">
      <LandingCategoryRail
        v-for="rail in rails?.countryRails"
        :key="rail.code"
        :title="$t('landing.rails.country.title', { name: rail.name })"
        :to="{ path: '/search', query: { country: rail.code } }"
      >
        <div v-for="a in rail.auctions" :key="`${a.platform}:${a.externalId}`" class="w-[calc(50%-0.5rem)] shrink-0 snap-start sm:w-72">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.bestCondition.length"
        :title="$t('landing.rails.bestCondition.title')"
        :subtitle="$t('landing.rails.bestCondition.subtitle')"
        :to="{ path: '/search', query: { condition: 'neuwertig,gepflegt' } }"
      >
        <div v-for="a in rails.bestCondition" :key="`${a.platform}:${a.externalId}`" class="w-[calc(50%-0.5rem)] shrink-0 snap-start sm:w-72">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-for="geo in geoRails"
        :key="geo.key"
        :title="$t(`landing.rails.${geo.key}.title`)"
        :subtitle="$t(`landing.rails.${geo.key}.subtitle`)"
        :to="{ path: '/search', query: geo.query }"
      >
        <div v-for="a in geo.items" :key="`${a.platform}:${a.externalId}`" class="w-[calc(50%-0.5rem)] shrink-0 snap-start sm:w-72">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>
    </div>

    <!-- Footer -->
    <footer class="mt-6 flex flex-col items-center justify-between gap-4 border-t px-6 py-8 text-sm text-muted-foreground sm:flex-row">
      <span class="flex items-center gap-2 font-semibold text-foreground">
        <SiteImmoHammerLogo class="h-6 w-6 text-amber-500" />
        {{ $t('nav.brand') }}
      </span>
      <span>{{ $t('landing.footer.tagline') }}</span>
      <span>{{ $t('landing.footer.legal') }}</span>
    </footer>
  </main>
</template>
