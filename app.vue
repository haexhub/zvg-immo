<script setup lang="ts">
// Bootstraps the account-locale sync once for the whole app.
useLocalePreference()
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
    <NuxtPage :keepalive="true" />
  </NuxtLayout>
</template>
