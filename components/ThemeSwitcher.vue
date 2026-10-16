<script setup lang="ts">
import type { ThemePreference } from '~/composables/useThemePreference'

const { theme, setPreferredTheme } = useThemePreference()
const options: ThemePreference[] = ['system', 'light', 'dark']
</script>

<template>
  <select
    :value="theme"
    class="h-9 rounded-md border bg-card px-2 text-sm shadow-xs hover:border-primary transition-colors"
    :aria-label="$t('themeSwitcher.label')"
    @change="setPreferredTheme(($event.target as HTMLSelectElement).value as ThemePreference)"
  >
    <option v-for="o in options" :key="o" :value="o">{{ $t(`themeSwitcher.options.${o}`) }}</option>
  </select>
</template>
