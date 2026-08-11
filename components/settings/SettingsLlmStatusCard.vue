<script setup lang="ts">
import type { StatusListItem } from '~/composables/settings/useSettingsStatusOverview'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

const { t } = useI18n()
const { startProgressPolling } = useSettingsTaskOverview()

async function retryOpen(code: string): Promise<void> {
  startProgressPolling()
  await $fetch(`/api/settings/countries/${code}/reprocess-backlog`, { method: 'POST' })
}
async function retryFailed(code: string): Promise<void> {
  startProgressPolling()
  await $fetch(`/api/settings/countries/${code}/reprocess-retry-failed`, { method: 'POST' })
}
async function retryItem(item: StatusListItem): Promise<void> {
  startProgressPolling()
  await $fetch(`/api/settings/auction/${item.platform}/${item.externalId}/reprocess-retry`, { method: 'POST' })
}
</script>

<template>
  <SettingsStatusCard
    kind="llm"
    :title="t('settings.llmStatus.title')"
    :description="t('settings.llmStatus.description')"
    :refresh-label="t('settings.llmStatus.refresh')"
    :empty-label="t('settings.llmStatus.empty')"
    :retry-open-label="t('settings.llmStatus.retryOpen')"
    :retry-failed-label="t('settings.llmStatus.retryFailed')"
    :retry-row-label="t('settings.llmStatus.retryRow')"
    :on-retry-open="retryOpen"
    :on-retry-failed="retryFailed"
    :on-retry-item="retryItem"
  >
    <template #extra-columns="{ bucket }">
      <TableHead v-if="bucket === 'error'">{{ t('settings.llmStatus.colFailures') }}</TableHead>
    </template>
    <template #extra-cells="{ item, bucket }">
      <TableCell v-if="bucket === 'error'" class="text-xs tabular-nums text-muted-foreground">{{ item.llmFailures }}</TableCell>
    </template>
  </SettingsStatusCard>
</template>
