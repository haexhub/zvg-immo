<script setup lang="ts">
import {
  Map as MapIcon, List, SlidersHorizontal, Languages,
  Sparkles, ScanSearch, Coins, Search, Check,
  Archive as ArchiveIcon, Calculator, ArrowRight,
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

const howIcons = [MapIcon, List, SlidersHorizontal, Languages]
const featureIcons = [Sparkles, ScanSearch, Coins, Languages]
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
            <Button variant="ghost" as-child>
              <a href="#how">{{ $t('landing.hero.ctaSecondary') }}</a>
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

    <!-- How it works -->
    <section id="how" class="flex min-h-svh scroll-mt-16 items-center bg-muted/30 px-6 py-20">
      <div class="mx-auto w-full max-w-6xl">
        <div class="mb-14 text-center">
          <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">
            <span class="text-amber-600 dark:text-amber-400">{{ $t('landing.how.heading') }}</span> {{ $t('landing.how.headingSuffix') }}
          </h2>
          <p class="mx-auto mt-3 max-w-2xl text-muted-foreground">{{ $t('landing.how.subheadline') }}</p>
        </div>
        <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="(item, i) in $tm('landing.how.items')"
            :key="i"
            class="relative rounded-xl border bg-card p-6 transition-shadow hover:shadow-md"
          >
            <span class="absolute right-5 top-4 select-none text-3xl font-bold tabular-nums text-amber-500/15">{{ String(i + 1).padStart(2, '0') }}</span>
            <div class="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <component :is="howIcons[i]" class="h-5 w-5" />
            </div>
            <h3 class="mb-1.5 font-semibold">{{ $rt(item.title) }}</h3>
            <p class="text-sm text-muted-foreground">{{ $rt(item.desc) }}</p>
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
        <div class="grid gap-6 sm:grid-cols-2">
          <Card v-for="(item, i) in $tm('landing.features.items')" :key="i" class="transition-shadow hover:shadow-md">
            <CardHeader>
              <div class="mb-2 flex h-11 w-11 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <component :is="featureIcons[i]" class="h-5 w-5" />
              </div>
              <CardTitle class="text-lg">{{ $rt(item.title) }}</CardTitle>
            </CardHeader>
            <CardContent>
              <p class="text-sm text-muted-foreground">{{ $rt(item.desc) }}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>

    <!-- Archive -->
    <section id="archive" class="flex min-h-svh scroll-mt-16 items-center px-6 py-20">
      <div class="mx-auto w-full max-w-2xl text-center">
        <div class="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <ArchiveIcon class="h-7 w-7" />
        </div>
        <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.archive.heading') }}</h2>
        <p class="mt-4 text-lg text-muted-foreground">{{ $t('landing.archive.body') }}</p>
        <p class="mt-2 text-xs text-muted-foreground">{{ $t('landing.archive.note') }}</p>
        <Button variant="outline" class="mt-6" as-child>
          <NuxtLink to="/search">{{ $t('landing.archive.cta') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
        </Button>
      </div>
    </section>

    <!-- Calculator -->
    <section id="calculator" class="flex min-h-svh scroll-mt-16 items-center bg-muted/30 px-6 py-20">
      <div class="mx-auto grid w-full max-w-4xl items-center gap-10 md:grid-cols-2">
        <div>
          <div class="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Calculator class="h-7 w-7" />
          </div>
          <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.calculator.heading') }}</h2>
          <p class="mt-4 text-muted-foreground">{{ $t('landing.calculator.body') }}</p>
          <p class="mt-3 text-xs text-muted-foreground">{{ $t('landing.calculator.note') }}</p>
          <Button variant="outline" class="mt-6" as-child>
            <NuxtLink to="/search">{{ $t('landing.calculator.cta') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
          </Button>
        </div>
        <ul class="space-y-3 rounded-xl border bg-card p-6">
          <li v-for="(b, i) in $tm('landing.calculator.bullets')" :key="i" class="flex items-start gap-3 text-sm">
            <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Check class="h-3 w-3" />
            </span>
            {{ $rt(b) }}
          </li>
        </ul>
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

    <!-- Final CTA -->
    <section class="relative flex min-h-svh items-center overflow-hidden bg-muted/30 px-6 py-20 text-center">
      <div class="pointer-events-none absolute left-1/2 top-1/2 h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-500/10 blur-3xl" />
      <div class="mx-auto w-full max-w-2xl space-y-6">
        <h2 class="text-3xl font-bold tracking-tight sm:text-5xl">{{ $t('landing.finalCta.heading') }}</h2>
        <p class="text-lg text-muted-foreground">{{ $t('landing.finalCta.subheadline') }}</p>
        <Button size="lg" as-child>
          <NuxtLink to="/search">{{ $t('landing.finalCta.cta') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
        </Button>
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
