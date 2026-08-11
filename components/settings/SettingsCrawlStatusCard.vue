<script setup lang="ts">
import type { StatusListItem } from '~/composables/settings/useSettingsStatusOverview'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

const { t } = useI18n()
const { startProgressPolling } = useSettingsTaskOverview()

// Scoped via enrich-worker.ts's `identities` option — a full country re-crawl
// (force-refetching every listing) stays available on SettingsCountrySourcesCard's
// "Enrich"-Button; these three only ever touch the exact auctions asked for.
async function retryOpen(code: string): Promise<void> {
  startProgressPolling()
  await $fetch(`/api/settings/countries/${code}/enrich-backlog`, { method: 'POST' })
}
async function retryFailed(code: string): Promise<void> {
  startProgressPolling()
  await $fetch(`/api/settings/countries/${code}/enrich-retry-failed`, { method: 'POST' })
}
async function retryItem(item: StatusListItem): Promise<void> {
  startProgressPolling()
  await $fetch(`/api/settings/auction/${item.platform}/${item.externalId}/enrich-retry`, { method: 'POST' })
}
</script>

<template>
  <SettingsStatusCard
    kind="crawl"
    :title="t('settings.crawlStatus.title')"
    :description="t('settings.crawlStatus.description')"
    :refresh-label="t('settings.crawlStatus.refresh')"
    :empty-label="t('settings.crawlStatus.empty')"
    :retry-open-label="t('settings.crawlStatus.retryOpen')"
    :retry-failed-label="t('settings.crawlStatus.retryFailed')"
    :retry-row-label="t('settings.crawlStatus.retryRow')"
    :on-retry-open="retryOpen"
    :on-retry-failed="retryFailed"
    :on-retry-item="retryItem"
  />
</template>
