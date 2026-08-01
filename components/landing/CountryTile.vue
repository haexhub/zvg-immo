<script setup lang="ts">
import type { CountryTileEntry } from '~/server/api/landing/rails.get'

defineProps<{
  country: CountryTileEntry
}>()
</script>

<template>
  <NuxtLink :to="{ path: '/search', query: { country: country.code } }" class="group block">
    <div class="relative aspect-4/3 overflow-hidden rounded-xl bg-muted">
      <img
        v-if="country.thumbnailUrl"
        :src="country.thumbnailUrl"
        :alt="country.name"
        class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
      <div v-else class="flex h-full w-full items-center justify-center text-2xl font-semibold text-muted-foreground">
        {{ country.code.toUpperCase() }}
      </div>
    </div>
    <p class="mt-2 text-sm font-medium leading-tight">{{ country.name }}</p>
    <p class="text-xs text-muted-foreground">{{ $t('landing.rails.countries.count', { count: country.count }) }}</p>
  </NuxtLink>
</template>
