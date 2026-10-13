<script setup lang="ts">
// Bootstraps the account-locale and -currency syncs once for the whole app.
// Their user watchers live in the setup scope of whoever calls them first,
// and only app.vue is never unmounted (layouts are, on every layout switch).
useLocalePreference()
useCurrencyPreference()
const { isDark } = useThemePreference()

const { t } = useI18n()
const i18nHead = useLocaleHead()
useHead(() => ({
  htmlAttrs: { ...i18nHead.value.htmlAttrs, class: isDark.value ? 'dark' : undefined },
  title: t('site.title'),
  meta: [{ name: 'description', content: t('site.description') }],
}))
</script>

<template>
  <NuxtLayout>
    <!-- No keepalive: NuxtLayout remounts its subtree on every layout switch,
         so a cached /search never survived the trip to a detail page anyway.
         A global cache only piled up every visited detail page with its map
         and live locale/translation watchers. -->
    <NuxtPage />
  </NuxtLayout>
</template>
