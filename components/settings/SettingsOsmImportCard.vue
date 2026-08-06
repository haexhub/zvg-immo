<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'
import type { OsmImportCountryStatus } from '~/server/api/settings/osm-import.get'

const { t } = useI18n()
const countryLabel = useCountryLabel()
const { normalizeSettingsError } = useSettingsError()
const { formatBatchDate } = useSettingsTaskOverview()

const countries = ref<OsmImportCountryStatus[]>([])
const pending = ref(false)
const loadError = ref<string | null>(null)
const requestPending = ref<string | null>(null)
const requestError = ref<string | null>(null)

async function load(): Promise<void> {
  pending.value = true
  loadError.value = null
  try {
    const res = await $fetch<{ countries: OsmImportCountryStatus[] }>('/api/settings/osm-import')
    countries.value = res.countries
  } catch (err) {
    loadError.value = normalizeSettingsError(err, t('settings.osmImport.loadError'))
  } finally {
    pending.value = false
  }
}

async function requestReimport(code: string): Promise<void> {
  if (requestPending.value) return
  requestPending.value = code
  requestError.value = null
  try {
    await $fetch(`/api/settings/osm-import/${code}`, { method: 'POST' })
    await load()
  } catch (err) {
    requestError.value = normalizeSettingsError(err, t('settings.osmImport.requestError'))
  } finally {
    requestPending.value = null
  }
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.osmImport.title') }}</CardTitle>
      <CardAction>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          :disabled="pending"
          :title="$t('settings.osmImport.refresh')"
          @click="load"
        >
          <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.osmImport.description') }}
      </p>

      <p v-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>
      <p v-if="requestError" class="text-sm text-destructive">{{ requestError }}</p>

      <div class="rounded-md border divide-y">
        <div v-for="country in countries" :key="country.code" class="flex items-start gap-3 px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <span class="block text-sm font-medium">
              {{ countryLabel(country.code) }}
              <span class="ml-1 font-mono text-xs uppercase text-muted-foreground">{{ country.code }}</span>
            </span>
            <span class="block text-xs text-muted-foreground">
              {{ country.rowCount > 0 ? $t('settings.osmImport.rowCount', { count: country.rowCount }) : $t('settings.osmImport.noData') }}
            </span>
            <span v-if="country.requestedAt" class="block text-xs text-amber-600 dark:text-amber-400">
              {{ $t('settings.osmImport.pending', { at: formatBatchDate(country.requestedAt) }) }}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="shrink-0"
            :disabled="requestPending !== null || !!country.requestedAt"
            @click="requestReimport(country.code)"
          >
            <Loader2 v-if="requestPending === country.code" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
            {{ requestPending === country.code ? $t('settings.osmImport.requesting') : $t('settings.osmImport.request') }}
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
