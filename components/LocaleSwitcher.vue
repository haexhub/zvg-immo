<script setup lang="ts">
const { locale, locales } = useI18n()
const { setPreferredLocale } = useLocalePreference()
</script>

<template>
  <select
    :value="locale"
    class="h-9 rounded-md border bg-card px-2 text-sm shadow-xs hover:border-primary transition-colors"
    :aria-label="$t('localeSwitcher.label')"
    @change="setPreferredLocale(($event.target as HTMLSelectElement).value as 'de' | 'en')"
  >
    <option v-for="l in locales" :key="typeof l === 'string' ? l : l.code" :value="typeof l === 'string' ? l : l.code">
      {{ typeof l === 'string' ? l : (l.name ?? l.code) }}
    </option>
  </select>
</template>
