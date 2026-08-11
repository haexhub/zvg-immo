<script setup lang="ts">
import type { StatusListItem } from '~/composables/settings/useSettingsStatusOverview'

const { t } = useI18n()

// The overview includes the proactive translation backlog as well as existing
// attempts. No startProgressPolling: these jobs do not go through crawl/LLM's
// tracked task-run system, so the card re-polls its own list.
async function retryOpen(code: string): Promise<void> {
  await $fetch(`/api/settings/countries/${code}/translation-retry-open`, { method: 'POST' })
}
async function retryFailed(code: string): Promise<void> {
  await $fetch(`/api/settings/countries/${code}/translation-retry-failed`, { method: 'POST' })
}
async function retryItem(item: StatusListItem): Promise<void> {
  await $fetch(`/api/settings/auction/${item.platform}/${item.externalId}/translation-retry`, { method: 'POST', body: { lang: item.lang } })
}
</script>

<template>
  <SettingsStatusCard
    kind="translation"
    :title="t('settings.translationStatus.title')"
    :description="t('settings.translationStatus.description')"
    :refresh-label="t('settings.translationStatus.refresh')"
    :empty-label="t('settings.translationStatus.empty')"
    :retry-open-label="t('settings.translationStatus.retryOpen')"
    :retry-failed-label="t('settings.translationStatus.retryFailed')"
    :retry-row-label="t('settings.translationStatus.retryRow')"
    :on-retry-open="retryOpen"
    :on-retry-failed="retryFailed"
    :on-retry-item="retryItem"
  >
    <template #extra-columns>
      <TableHead>{{ t('settings.translationStatus.colLang') }}</TableHead>
    </template>
    <template #extra-cells="{ item }">
      <TableCell class="whitespace-nowrap font-mono text-xs uppercase">{{ item.lang }}</TableCell>
    </template>
  </SettingsStatusCard>
</template>
