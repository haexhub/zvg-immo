<script setup lang="ts">
import {
  Map as MapIcon, Languages,
  Sparkles, Images, FileText, Mail, Search, Check,
  Calculator, ArrowRight,
} from 'lucide-vue-next'
import type { CountryEntry } from '~/server/crawlers/registry'
import type { SiteStats } from '~/server/api/stats.get'

const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', { default: () => [] })
const { data: stats } = await useFetch<SiteStats | null>('/api/stats', { default: () => null })

const intlLocale = useIntlLocale()
const router = useRouter()

const countryCount = computed(() => stats.value?.countryCount ?? countries.value?.length ?? 0)
const regionCount = computed(() => stats.value?.regionCount ?? 0)
const hasLiveStats = computed(() => !!stats.value && stats.value.totalCount > 0)

const searchQuery = ref('')
function submitSearch() {
  const q = searchQuery.value.trim()
  router.push({ path: '/search', query: q ? { q } : {} })
}

const featureIcons = [Sparkles, MapIcon, Images, FileText, Calculator, Mail, Languages]
const featureColors = [
  'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
  'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  'bg-rose-500/10 text-rose-600 dark:text-rose-400',
]
</script>

<template>
  <main class="scroll-smooth">
    <!-- Hero -->
    <section class="relative flex min-h-[calc(100svh-4rem)] items-center overflow-hidden px-6 py-14 lg:py-10">
      <div class="pointer-events-none absolute -right-40 -top-40 h-160 w-160 rounded-full bg-amber-500/10 blur-3xl" />
      <div class="pointer-events-none absolute -bottom-56 -left-56 h-160 w-160 rounded-full bg-amber-500/5 blur-3xl" />
      <div class="mx-auto grid w-full max-w-7xl items-center gap-12 lg:grid-cols-2 lg:gap-8">
        <div class="max-w-xl space-y-6">
          <span class="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            <span class="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {{ $t('landing.hero.eyebrow') }}
          </span>
          <h1 class="text-4xl font-bold tracking-tight sm:text-5xl xl:text-6xl">
            {{ $t('landing.hero.headline') }}
            <span class="bg-gradient-to-r from-amber-500 to-amber-600 bg-clip-text text-transparent">{{ $t('landing.hero.headlineHighlight') }}</span>
            {{ $t('landing.hero.headlineSuffix') }}
          </h1>
          <p class="text-lg text-muted-foreground">{{ $t('landing.hero.subheadline') }}</p>

          <i18n-t v-if="hasLiveStats" keypath="landing.hero.statLive" tag="p" class="text-base">
            <template #total>
              <span class="text-xl font-bold text-amber-600 dark:text-amber-400">{{ stats!.totalCount.toLocaleString(intlLocale) }}</span>
            </template>
            <template #countries>
              <span class="font-semibold">{{ countryCount }}</span>
            </template>
            <template #regions>
              <span class="font-semibold">{{ regionCount }}</span>
            </template>
          </i18n-t>
          <p v-else class="text-base text-muted-foreground">{{ $t('landing.hero.statPlaceholder') }}</p>

          <form class="flex w-full max-w-lg items-center gap-2" @submit.prevent="submitSearch">
            <Input
              v-model="searchQuery"
              :placeholder="$t('landing.hero.searchPlaceholder')"
              class="h-12 flex-1 rounded-lg bg-background text-base shadow-sm"
            />
            <Button type="submit" size="lg" class="h-12 px-5">
              <Search class="h-4 w-4" />{{ $t('landing.hero.searchCta') }}
            </Button>
          </form>

          <ul class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <li v-for="(item, i) in $tm('landing.hero.trust')" :key="i" class="inline-flex items-center gap-1.5">
              <Check class="h-3.5 w-3.5 text-amber-500" />{{ $rt(item) }}
            </li>
          </ul>

          <div class="flex flex-wrap items-center gap-3 pt-1">
            <Button variant="outline" as-child>
              <NuxtLink to="/search">{{ $t('landing.hero.ctaPrimary') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
            </Button>
          </div>
        </div>

        <!-- Interactive Europe map -->
        <div class="w-full">
          <LandingEuropeMap
            :countries="countries ?? []"
            class="mx-auto w-full max-w-md drop-shadow-sm lg:h-[min(78svh,46rem)] lg:w-auto lg:max-w-none"
          />
          <div class="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
            <span class="inline-flex items-center gap-1.5">
              <span class="h-3 w-3 rounded-sm bg-amber-500" />{{ $t('landing.hero.legendAvailable') }}
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span class="h-3 w-3 rounded-sm bg-muted-foreground/15" />{{ $t('landing.hero.legendSoon') }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- Coverage -->
    <section class="flex min-h-svh items-center px-6 py-20">
      <div class="mx-auto w-full max-w-5xl">
        <div class="mb-12 text-center">
          <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.coverage.heading') }}</h2>
          <p class="mx-auto mt-3 max-w-2xl text-muted-foreground">{{ $t('landing.coverage.subheadline') }}</p>
        </div>
        <div class="mb-12 grid gap-4 sm:grid-cols-3">
          <div class="rounded-xl border bg-card p-6 text-center">
            <div class="text-4xl font-bold tracking-tight text-amber-600 dark:text-amber-400 sm:text-5xl">
              {{ hasLiveStats ? stats!.totalCount.toLocaleString(intlLocale) : '—' }}
            </div>
            <div class="mt-1.5 text-sm text-muted-foreground">{{ $t('landing.coverage.tileListings') }}</div>
          </div>
          <div class="rounded-xl border bg-card p-6 text-center">
            <div class="text-4xl font-bold tracking-tight text-amber-600 dark:text-amber-400 sm:text-5xl">
              {{ hasLiveStats ? countryCount : '20+' }}
            </div>
            <div class="mt-1.5 text-sm text-muted-foreground">{{ $t('landing.coverage.tileCountries') }}</div>
          </div>
          <div class="rounded-xl border bg-card p-6 text-center">
            <div class="text-4xl font-bold tracking-tight text-amber-600 dark:text-amber-400 sm:text-5xl">
              {{ hasLiveStats ? regionCount : '100+' }}
            </div>
            <div class="mt-1.5 text-sm text-muted-foreground">{{ $t('landing.coverage.tileRegions') }}</div>
          </div>
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          <Badge v-for="c in countries" :key="c.code" variant="secondary" class="text-sm">
            {{ c.name }}
          </Badge>
        </div>
        <div class="mt-10 text-center">
          <p class="mb-4 text-xs text-muted-foreground">{{ $t('landing.coverage.note') }}</p>
          <Button variant="outline" as-child>
            <NuxtLink to="/search">{{ $t('landing.coverage.cta') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
          </Button>
        </div>
      </div>
    </section>

    <!-- AI / unique features -->
    <section id="features" class="flex min-h-svh scroll-mt-16 items-center bg-muted/30 px-6 py-20">
      <div class="mx-auto w-full max-w-6xl">
        <div class="mb-14 text-center">
          <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.features.heading') }}</h2>
          <p class="mx-auto mt-3 max-w-2xl text-muted-foreground">{{ $t('landing.features.subheadline') }}</p>
        </div>
        <div class="flex flex-wrap justify-center gap-6">
          <Card
            v-for="(item, i) in ($tm('landing.features.items') as Array<{ title: string; desc: string; badge: string }>)"
            :key="i"
            class="w-full transition-shadow hover:shadow-md sm:w-[calc(50%_-_0.75rem)] lg:w-[calc(25%_-_1.125rem)]"
          >
            <CardHeader>
              <div :class="['mb-2 flex h-11 w-11 items-center justify-center rounded-lg', featureColors[i]]">
                <component :is="featureIcons[i]" class="h-5 w-5" />
              </div>
              <CardTitle class="text-lg">{{ $rt(item.title) }}</CardTitle>
              <span :class="['w-fit rounded-full px-2.5 py-0.5 text-xs font-medium', featureColors[i]]">{{ $rt(item.badge) }}</span>
            </CardHeader>
            <CardContent>
              <p class="text-sm text-muted-foreground">{{ $rt(item.desc) }}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section id="faq" class="flex min-h-svh scroll-mt-16 items-center px-6 py-20">
      <div class="mx-auto w-full max-w-2xl">
        <h2 class="mb-8 text-center text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.faq.heading') }}</h2>
        <Accordion type="single" collapsible>
          <AccordionItem v-for="(item, i) in $tm('landing.faq.items')" :key="i" :value="`faq-${i}`">
            <AccordionTrigger>{{ $rt(item.q) }}</AccordionTrigger>
            <AccordionContent>{{ $rt(item.a) }}</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>

    <!-- Footer -->
    <footer class="flex flex-col items-center justify-between gap-4 border-t px-6 py-8 text-sm text-muted-foreground sm:flex-row">
      <span class="flex items-center gap-2 font-semibold text-foreground">
        <SitePropHammerLogo class="h-6 w-6 text-amber-500" />
        {{ $t('nav.brand') }}
      </span>
      <span>{{ $t('landing.footer.tagline') }}</span>
      <span>{{ $t('landing.footer.legal') }}</span>
    </footer>
  </main>
</template>
