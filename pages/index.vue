<script setup lang="ts">
import { Search } from 'lucide-vue-next'
import type { LandingRailsResponse } from '~/server/api/landing/rails.get'
import type { CountryEntry } from '~/server/crawlers/registry'

// Independent endpoints — fetch concurrently rather than serially awaiting
// one after the other.
const [{ data: rails }, { data: countries }] = await Promise.all([
  useFetch<LandingRailsResponse | null>('/api/landing/rails', {
    cache: 'no-store',
    default: () => null,
  }),
  useFetch<CountryEntry[]>('/api/regions', {
    cache: 'no-store',
    default: () => [],
  }),
])

const geoRails = computed(() => {
  if (!rails.value) return []
  return (['sea', 'mountains', 'lakes', 'rivers'] as const)
    .map((key) => ({ key, items: rails.value![key] }))
    .filter((geo) => geo.items.length > 0)
})

const router = useRouter()
const searchQuery = ref('')
function submitSearch() {
  const q = searchQuery.value.trim()
  router.push({ path: '/search', query: q ? { q } : {} })
}
function selectCountry(code: string) {
  router.push({ path: '/search', query: { country: code } })
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
              :countries="countries ?? []"
              @select-country="selectCountry"
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
    <div class="w-full px-3">
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
        v-for="geo in geoRails"
        :key="geo.key"
        :title="$t(`landing.rails.${geo.key}.title`)"
        :subtitle="$t(`landing.rails.${geo.key}.subtitle`)"
      >
        <div v-for="a in geo.items" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
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
