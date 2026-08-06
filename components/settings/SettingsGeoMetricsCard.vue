<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'
import type { GeoMetricsStatus } from '~/server/api/settings/geo-metrics.get'
import type { GeoMetricsRebuildResult } from '~/server/api/settings/geo-metrics.post'

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()
const { formatBatchDate } = useSettingsTaskOverview()

const status = ref<GeoMetricsStatus | null>(null)
const pending = ref(false)
const loadError = ref<string | null>(null)
const rebuildPending = ref(false)
const rebuildError = ref<string | null>(null)
const rebuildStarted = ref(false)

async function load(): Promise<void> {
  pending.value = true
  loadError.value = null
  try {
    status.value = await $fetch<GeoMetricsStatus>('/api/settings/geo-metrics')
  } catch (err) {
    loadError.value = normalizeSettingsError(err, t('settings.geoMetrics.loadError'))
  } finally {
    pending.value = false
  }
}

async function rebuild(): Promise<void> {
  if (rebuildPending.value) return
  rebuildPending.value = true
  rebuildError.value = null
  rebuildStarted.value = false
  try {
    await $fetch<GeoMetricsRebuildResult>('/api/settings/geo-metrics', { method: 'POST' })
    rebuildStarted.value = true
    await load()
  } catch (err) {
    rebuildError.value = normalizeSettingsError(err, t('settings.geoMetrics.rebuildError'))
  } finally {
    rebuildPending.value = false
  }
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.geoMetrics.title') }}</CardTitle>
      <CardAction>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          :disabled="pending"
          :title="$t('settings.geoMetrics.refresh')"
          @click="load"
        >
          <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.geoMetrics.description') }}
      </p>

      <p v-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>
      <p v-if="rebuildError" class="text-sm text-destructive">{{ rebuildError }}</p>
      <p v-if="rebuildStarted" class="text-sm text-muted-foreground">{{ $t('settings.geoMetrics.rebuildStarted') }}</p>

      <dl v-if="status" class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt class="text-muted-foreground">{{ $t('settings.geoMetrics.geoFeaturesRows') }}</dt>
        <dd>{{ status.geoFeaturesRows }}</dd>
        <dt class="text-muted-foreground">{{ $t('settings.geoMetrics.auctionGeoMetricsRows') }}</dt>
        <dd>{{ status.auctionGeoMetricsRows }}</dd>
        <template v-if="status.latestEpochCompletedAt">
          <dt class="text-muted-foreground">{{ $t('settings.geoMetrics.latestEpoch') }}</dt>
          <dd>{{ formatBatchDate(status.latestEpochCompletedAt) }}</dd>
        </template>
      </dl>

      <Button type="button" variant="outline" size="sm" :disabled="rebuildPending" @click="rebuild">
        <Loader2 v-if="rebuildPending" class="h-4 w-4 animate-spin" />
        <RefreshCw v-else class="h-4 w-4" />
        {{ rebuildPending ? $t('settings.geoMetrics.rebuilding') : $t('settings.geoMetrics.rebuild') }}
      </Button>
    </CardContent>
  </Card>
</template>
