<script setup lang="ts">
// Bootstraps the account-locale sync once for the whole app (no shared
// layout to hang this off — see AuthStatus.vue's header comment).
useLocalePreference()

const { t } = useI18n()
const i18nHead = useLocaleHead()
useHead(() => ({
  htmlAttrs: i18nHead.value.htmlAttrs,
  title: t('site.title'),
  meta: [{ name: 'description', content: t('site.description') }],
}))
</script>

<template>
  <NuxtPage :keepalive="true" />
</template>
