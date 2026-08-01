<script setup lang="ts">
import { Search } from 'lucide-vue-next'
import type { LandingRailsResponse } from '~/server/api/landing/rails.get'

const { data: rails } = await useFetch<LandingRailsResponse | null>('/api/landing/rails', {
  cache: 'no-store',
  default: () => null,
})

const router = useRouter()
const searchQuery = ref('')
function submitSearch() {
  const q = searchQuery.value.trim()
  router.push({ path: '/search', query: q ? { q } : {} })
}
</script>

<template>
  <main>
    <!-- Search -->
    <section class="border-b px-6 py-10 sm:py-14">
      <div class="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 text-center">
        <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.hero.headline') }}</h1>
        <p class="max-w-xl text-muted-foreground">{{ $t('landing.hero.subheadline') }}</p>
        <form class="flex w-full max-w-lg items-center gap-2" @submit.prevent="submitSearch">
          <div class="relative flex-1">
            <SearchLocationAutocomplete
              v-model="searchQuery"
              :placeholder="$t('landing.hero.searchPlaceholder')"
              input-class="h-12 w-full rounded-full bg-background text-base shadow-sm"
            />
          </div>
          <Button type="submit" size="lg" class="h-12 rounded-full px-5">
            <Search class="h-4 w-4" />{{ $t('landing.hero.searchCta') }}
          </Button>
        </form>
        <ul class="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          <li v-for="(item, i) in $tm('landing.hero.trust')" :key="i">{{ $rt(item) }}</li>
        </ul>
      </div>
    </section>

    <!-- Category rails -->
    <div class="mx-auto w-full max-w-7xl px-6">
      <LandingCategoryRail v-for="rail in rails?.countryRails" :key="rail.code" :title="$t('landing.rails.country.title', { name: rail.name })">
        <div v-for="a in rail.auctions" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.bestCondition.length"
        :title="$t('landing.rails.bestCondition.title')"
        :subtitle="$t('landing.rails.bestCondition.subtitle')"
      >
        <div v-for="a in rails.bestCondition" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.sea.length"
        :title="$t('landing.rails.sea.title')"
        :subtitle="$t('landing.rails.sea.subtitle')"
      >
        <div v-for="a in rails.sea" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.mountains.length"
        :title="$t('landing.rails.mountains.title')"
        :subtitle="$t('landing.rails.mountains.subtitle')"
      >
        <div v-for="a in rails.mountains" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.lakes.length"
        :title="$t('landing.rails.lakes.title')"
        :subtitle="$t('landing.rails.lakes.subtitle')"
      >
        <div v-for="a in rails.lakes" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.rivers.length"
        :title="$t('landing.rails.rivers.title')"
        :subtitle="$t('landing.rails.rivers.subtitle')"
      >
        <div v-for="a in rails.rivers" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>
    </div>

    <!-- Footer -->
    <footer class="mt-6 flex flex-col items-center justify-between gap-4 border-t px-6 py-8 text-sm text-muted-foreground sm:flex-row">
      <span class="flex items-center gap-2 font-semibold text-foreground">
        <SitePropHammerLogo class="h-6 w-6 text-amber-500" />
        {{ $t('nav.brand') }}
      </span>
      <span>{{ $t('landing.footer.tagline') }}</span>
      <span>{{ $t('landing.footer.legal') }}</span>
    </footer>
  </main>
</template>
