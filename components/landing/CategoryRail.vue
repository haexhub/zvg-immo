<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
  /** Search-page target for this category — renders a "show all" link when set. */
  to?: { path: string; query?: Record<string, string> }
}>()
</script>

<template>
  <section class="py-6">
    <div class="mb-3 flex items-baseline justify-between gap-3 px-1">
      <div>
        <NuxtLink v-if="to" :to="to" class="hover:underline">
          <h2 class="text-xl font-semibold tracking-tight sm:text-2xl">{{ title }}</h2>
        </NuxtLink>
        <h2 v-else class="text-xl font-semibold tracking-tight sm:text-2xl">{{ title }}</h2>
        <p v-if="subtitle" class="text-sm text-muted-foreground">{{ subtitle }}</p>
      </div>
      <NuxtLink v-if="to" :to="to" class="shrink-0 text-sm font-medium text-muted-foreground hover:text-foreground">
        {{ $t('landing.rails.showAll') }}
      </NuxtLink>
    </div>
    <div class="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-1 pb-2">
      <slot />
    </div>
  </section>
</template>
