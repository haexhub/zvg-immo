<script setup lang="ts">
import { Globe2, ListFilter, Map as MapIcon, Languages, Sparkles, Ruler, Coins, Smartphone, Gauge } from 'lucide-vue-next'
import type { CountryEntry } from '~/server/crawlers/registry'
import type { SiteStats } from '~/server/api/stats.get'

const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', { default: () => [] })
const { data: stats } = await useFetch<SiteStats | null>('/api/stats', { default: () => null })

const countryCount = computed(() => stats.value?.countryCount ?? countries.value?.length ?? 0)
const regionCount = computed(() => stats.value?.regionCount ?? 0)
const hasLiveStats = computed(() => !!stats.value && stats.value.totalCount > 0)

const valueIcons = [MapIcon, ListFilter, Ruler, Languages]
const featureIcons = [Sparkles, Gauge, Coins, Languages]
</script>

<template>
  <main>
    <!-- Hero -->
    <section class="px-4 py-16 md:py-24 text-center">
      <div class="mx-auto max-w-3xl space-y-6">
        <h1 class="text-3xl md:text-5xl font-bold tracking-tight">
          {{ $t('landing.hero.headline') }}
          <span class="bg-linear-to-b from-blue-400 to-blue-600 bg-clip-text text-transparent">{{ $t('landing.hero.headlineHighlight') }}</span>
          {{ $t('landing.hero.headlineSuffix') }}
        </h1>
        <p class="text-lg text-muted-foreground">{{ $t('landing.hero.subheadline') }}</p>
        <p class="text-sm text-muted-foreground">
          {{ hasLiveStats
            ? $t('landing.hero.statLive', { total: stats!.totalCount.toLocaleString(), countries: countryCount, regions: regionCount })
            : $t('landing.hero.statPlaceholder') }}
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button size="lg" as-child>
            <NuxtLink to="/search">{{ $t('landing.hero.ctaPrimary') }}</NuxtLink>
          </Button>
          <Button size="lg" variant="outline" as-child>
            <a href="#demo">{{ $t('landing.hero.ctaSecondary') }}</a>
          </Button>
        </div>
      </div>
    </section>

    <!-- Value proposition -->
    <section class="px-4 py-12 bg-muted/30">
      <div class="mx-auto max-w-5xl">
        <h2 class="text-center text-2xl md:text-3xl font-bold mb-8">
          <span class="text-primary">{{ $t('landing.value.heading') }}</span> {{ $t('landing.value.headingSuffix') }}
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div v-for="(item, i) in $tm('landing.value.items')" :key="i" class="text-center space-y-2">
            <div class="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <component :is="valueIcons[i]" class="h-5 w-5" />
            </div>
            <h3 class="font-semibold">{{ $rt(item.title) }}</h3>
            <p class="text-sm text-muted-foreground">{{ $rt(item.desc) }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Coverage -->
    <section class="px-4 py-12">
      <div class="mx-auto max-w-5xl grid md:grid-cols-2 gap-8 items-center">
        <div class="space-y-4">
          <h2 class="text-2xl md:text-3xl font-bold">
            {{ hasLiveStats ? countryCount : '' }} {{ $t('landing.coverage.heading') }}
          </h2>
          <p class="text-muted-foreground">{{ $t('landing.coverage.subheadline') }}</p>
          <p class="text-sm font-medium">
            {{ hasLiveStats
              ? $t('landing.coverage.stat', { countries: countryCount, regions: regionCount })
              : $t('landing.coverage.statPlaceholder') }}
          </p>
          <p class="text-xs text-muted-foreground">{{ $t('landing.coverage.note') }}</p>
          <Button variant="outline" as-child>
            <NuxtLink to="/search">{{ $t('landing.coverage.cta') }}</NuxtLink>
          </Button>
        </div>
        <div class="flex flex-wrap gap-2 content-start">
          <Badge v-for="c in countries" :key="c.code" variant="secondary" class="text-sm">
            <Globe2 class="h-3 w-3" />{{ c.name }}
          </Badge>
        </div>
      </div>
    </section>

    <!-- AI / unique features -->
    <section class="px-4 py-12 bg-muted/30">
      <div class="mx-auto max-w-5xl">
        <h2 class="text-center text-2xl md:text-3xl font-bold mb-8">{{ $t('landing.features.heading') }}</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <Card v-for="(item, i) in $tm('landing.features.items')" :key="i">
            <CardHeader>
              <component :is="featureIcons[i]" class="h-6 w-6 text-primary mb-2" />
              <CardTitle class="text-base">{{ $rt(item.title) }}</CardTitle>
            </CardHeader>
            <CardContent>
              <p class="text-sm text-muted-foreground">{{ $rt(item.desc) }}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>

    <!-- Product demo -->
    <section id="demo" class="px-4 py-16 text-center">
      <div class="mx-auto max-w-2xl space-y-4">
        <h2 class="text-2xl md:text-3xl font-bold">{{ $t('landing.demo.heading') }}</h2>
        <p class="text-muted-foreground">{{ $t('landing.demo.subheadline') }}</p>
        <Button size="lg" as-child>
          <NuxtLink to="/search">{{ $t('landing.demo.cta') }}</NuxtLink>
        </Button>
      </div>
    </section>

    <!-- Archive teaser -->
    <section id="archive" class="px-4 py-12 bg-muted/30">
      <div class="mx-auto max-w-3xl text-center space-y-3">
        <h2 class="text-2xl md:text-3xl font-bold">{{ $t('landing.archive.heading') }}</h2>
        <p class="text-muted-foreground">{{ $t('landing.archive.body') }}</p>
        <p class="text-xs text-muted-foreground">{{ $t('landing.archive.note') }}</p>
      </div>
    </section>

    <!-- Calculator teaser -->
    <section id="calculator" class="px-4 py-12">
      <div class="mx-auto max-w-3xl text-center space-y-3">
        <h2 class="text-2xl md:text-3xl font-bold">{{ $t('landing.calculator.heading') }}</h2>
        <p class="text-muted-foreground">{{ $t('landing.calculator.body') }}</p>
        <ul class="text-sm text-muted-foreground space-y-1">
          <li v-for="(b, i) in $tm('landing.calculator.bullets')" :key="i">{{ $rt(b) }}</li>
        </ul>
        <p class="text-xs text-muted-foreground">{{ $t('landing.calculator.note') }}</p>
        <Button variant="outline" as-child>
          <NuxtLink to="/search">{{ $t('landing.calculator.cta') }}</NuxtLink>
        </Button>
      </div>
    </section>

    <!-- App teaser -->
    <section class="px-4 py-12 bg-muted/30">
      <div class="mx-auto max-w-3xl text-center space-y-3">
        <Smartphone class="mx-auto h-8 w-8 text-primary" />
        <h2 class="text-2xl md:text-3xl font-bold">{{ $t('landing.app.heading') }}</h2>
        <p class="text-muted-foreground">{{ $t('landing.app.body') }}</p>
        <Button variant="outline" as-child>
          <NuxtLink to="/search">{{ $t('landing.app.cta') }}</NuxtLink>
        </Button>
      </div>
    </section>

    <!-- UX callout -->
    <section class="px-4 py-12 text-center">
      <div class="mx-auto max-w-2xl space-y-3">
        <h2 class="text-2xl md:text-3xl font-bold">{{ $t('landing.ux.heading') }}</h2>
        <p class="text-muted-foreground">{{ $t('landing.ux.body') }}</p>
      </div>
    </section>

    <!-- FAQ -->
    <section class="px-4 py-12 bg-muted/30">
      <div class="mx-auto max-w-2xl">
        <h2 class="text-center text-2xl md:text-3xl font-bold mb-6">{{ $t('landing.faq.heading') }}</h2>
        <Accordion type="single" collapsible>
          <AccordionItem v-for="(item, i) in $tm('landing.faq.items')" :key="i" :value="`faq-${i}`">
            <AccordionTrigger>{{ $rt(item.q) }}</AccordionTrigger>
            <AccordionContent>{{ $rt(item.a) }}</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>

    <!-- Final CTA -->
    <section class="px-4 py-16 text-center">
      <h2 class="text-2xl md:text-3xl font-bold mb-4">{{ $t('landing.finalCta.heading') }}</h2>
      <Button size="lg" as-child>
        <NuxtLink to="/search">{{ $t('landing.finalCta.cta') }}</NuxtLink>
      </Button>
    </section>

    <!-- Footer -->
    <footer class="border-t px-4 py-8 text-center text-sm text-muted-foreground">
      {{ $t('landing.footer.tagline') }}
    </footer>
  </main>
</template>
