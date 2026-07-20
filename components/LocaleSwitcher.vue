<script setup lang="ts">
// @nuxtjs/i18n augments the Composer with `locales` at runtime (see its
// runtime/types.d.ts ComposerCustomProperties) but doesn't merge that type
// into vue-i18n's own Composer interface, so useI18n()'s return type is
// missing it here.
const { locale, locales } = useI18n() as ReturnType<typeof useI18n> & {
  locales: Array<string | { code: string; name?: string }>
}
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
