<script setup lang="ts">
import {
  Map as MapIcon, List, SlidersHorizontal, Languages,
  Sparkles, ScanSearch, Coins, Globe2, MapPin, Gavel,
  Archive as ArchiveIcon, Calculator, ArrowRight, Check,
} from 'lucide-vue-next'
import type { CountryEntry } from '~/server/crawlers/registry'
import type { SiteStats } from '~/server/api/stats.get'

const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', { default: () => [] })
const { data: stats } = await useFetch<SiteStats | null>('/api/stats', { default: () => null })

const intlLocale = useIntlLocale()

const countryCount = computed(() => stats.value?.countryCount ?? countries.value?.length ?? 0)
const regionCount = computed(() => stats.value?.regionCount ?? 0)
const hasLiveStats = computed(() => !!stats.value && stats.value.totalCount > 0)

const howIcons = [MapIcon, List, SlidersHorizontal, Languages]
const featureIcons = [Sparkles, ScanSearch, Coins, Languages]
</script>

<template>
  <main class="scroll-smooth">
    <!-- Hero -->
    <section class="relative flex min-h-[calc(100svh-4rem)] items-center overflow-hidden px-6 py-16">
      <div class="pointer-events-none absolute -right-40 -top-40 h-144 w-144 rounded-full bg-amber-500/10 blur-3xl" />
      <div class="mx-auto grid w-full max-w-6xl items-center gap-12 md:grid-cols-2">
        <div class="space-y-6">
          <span class="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            <span class="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {{ $t('landing.hero.eyebrow') }}
          </span>
          <h1 class="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            {{ $t('landing.hero.headline') }}
            <span class="bg-gradient-to-r from-amber-500 to-amber-600 bg-clip-text text-transparent">{{ $t('landing.hero.headlineHighlight') }}</span>
            {{ $t('landing.hero.headlineSuffix') }}
          </h1>
          <p class="max-w-xl text-lg text-muted-foreground">{{ $t('landing.hero.subheadline') }}</p>
          <div class="flex flex-wrap items-center gap-3 pt-2">
            <Button size="lg" as-child>
              <NuxtLink to="/search">{{ $t('landing.hero.ctaPrimary') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
            </Button>
            <Button size="lg" variant="outline" as-child>
              <a href="#how">{{ $t('landing.hero.ctaSecondary') }}</a>
            </Button>
          </div>
          <p class="text-sm text-muted-foreground">
            {{ hasLiveStats
              ? $t('landing.hero.statLive', { total: stats!.totalCount.toLocaleString(intlLocale), countries: countryCount, regions: regionCount })
              : $t('landing.hero.statPlaceholder') }}
          </p>
        </div>

        <!-- Interactive Europe map -->
        <div class="relative">
          <div class="overflow-hidden rounded-xl border bg-card shadow-2xl">
            <div class="flex items-center gap-2 border-b bg-muted/50 px-4 py-2.5">
              <MapPin class="h-3.5 w-3.5 text-amber-500" />
              <span class="text-xs font-medium text-muted-foreground">{{ $t('landing.hero.mapLabel') }}</span>
              <span class="ml-auto text-xs text-muted-foreground">{{ $t('landing.hero.mapHint') }}</span>
            </div>
            <div class="p-4 sm:p-6">
              <LandingEuropeMap :countries="countries ?? []" />
            </div>
            <div class="flex flex-wrap items-center gap-4 border-t px-4 py-3 text-xs text-muted-foreground">
              <span class="inline-flex items-center gap-1.5">
                <span class="h-3 w-3 rounded-sm bg-amber-500" />{{ $t('landing.hero.legendAvailable') }}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span class="h-3 w-3 rounded-sm bg-muted-foreground/15" />{{ $t('landing.hero.legendSoon') }}
              </span>
            </div>
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
          <div v-for="(item, i) in $tm('landing.how.items')" :key="i" class="rounded-xl border bg-card p-6">
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
      <div class="mx-auto grid w-full max-w-6xl items-center gap-12 md:grid-cols-2">
        <div class="space-y-5">
          <div class="text-6xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
            {{ hasLiveStats ? countryCount : '20+' }}
          </div>
          <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.coverage.heading') }}</h2>
          <p class="text-muted-foreground">{{ $t('landing.coverage.subheadline') }}</p>
          <p class="text-sm font-medium">
            {{ hasLiveStats
              ? $t('landing.coverage.stat', { countries: countryCount, regions: regionCount })
              : $t('landing.coverage.statPlaceholder') }}
          </p>
          <p class="text-xs text-muted-foreground">{{ $t('landing.coverage.note') }}</p>
          <Button variant="outline" as-child>
            <NuxtLink to="/search">{{ $t('landing.coverage.cta') }}<ArrowRight class="h-4 w-4" /></NuxtLink>
          </Button>
        </div>
        <div class="flex flex-wrap content-start gap-2">
          <Badge v-for="c in countries" :key="c.code" variant="secondary" class="text-sm">
            <Globe2 class="h-3 w-3" />{{ c.name }}
          </Badge>
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
          <Card v-for="(item, i) in $tm('landing.features.items')" :key="i" class="border-l-4 border-l-amber-500/60">
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
        <span class="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500 text-white">
          <Gavel class="h-3.5 w-3.5" />
        </span>
        {{ $t('nav.brand') }}
      </span>
      <span>{{ $t('landing.footer.tagline') }}</span>
      <span>{{ $t('landing.footer.legal') }}</span>
    </footer>
  </main>
</template>
