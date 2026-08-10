<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsAction } from '~/composables/settings/useSettingsAction'
import { useSettingsStatusOverview, type StatusBucket } from '~/composables/settings/useSettingsStatusOverview'

const { rows, pending, error, load, list, listPending, listError, loadList, clearList, LIST_LIMIT } = useSettingsStatusOverview('llm')

const selectedCountry = ref<string | null>(null)
const selectedBucket = ref<StatusBucket | null>(null)
const offset = ref(0)

function selectSegment(country: string, bucket: StatusBucket): void {
  if (selectedCountry.value === country && selectedBucket.value === bucket) {
    selectedCountry.value = null
    selectedBucket.value = null
    clearList()
    return
  }
  selectedCountry.value = country
  selectedBucket.value = bucket
  offset.value = 0
  void loadList(country, bucket, 0)
}

function changePage(step: number): void {
  if (!selectedCountry.value || !selectedBucket.value) return
  offset.value = Math.max(0, offset.value + step * LIST_LIMIT)
  void loadList(selectedCountry.value, selectedBucket.value, offset.value)
}

// Two independent trigger endpoints share one pending/error pair: they're
// mutually exclusive per country row (never fired at the same time) and
// both just kick off the same detached reprocess task.
const retryAction = useSettingsAction()
async function retryOpen(code: string): Promise<void> {
  await retryAction.run(async () => {
    await $fetch(`/api/settings/countries/${code}/reprocess-backlog`, { method: 'POST' })
    await load()
  }, 'settings.llmStatus.retryError')
}
async function retryFailed(code: string): Promise<void> {
  await retryAction.run(async () => {
    await $fetch(`/api/settings/countries/${code}/reprocess-retry-failed`, { method: 'POST' })
    await load()
  }, 'settings.llmStatus.retryError')
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.llmStatus.title') }}</CardTitle>
      <CardAction>
        <Button type="button" variant="ghost" size="icon-sm" :disabled="pending" :title="$t('settings.llmStatus.refresh')" @click="load">
          <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ $t('settings.llmStatus.description') }}</p>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="retryAction.error.value" class="text-sm text-destructive">{{ retryAction.error.value }}</p>
      <p v-if="!pending && rows.length === 0" class="text-sm text-muted-foreground">{{ $t('settings.llmStatus.empty') }}</p>

      <div class="divide-y rounded-md border">
        <template v-for="row in rows" :key="row.code">
          <div class="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span class="text-sm font-medium">
              {{ row.label }}
              <span class="ml-1 font-mono text-xs uppercase text-muted-foreground">{{ row.code }}</span>
            </span>
            <SettingsStatusDonut
              :counts="row"
              :selected="selectedCountry === row.code ? selectedBucket : null"
              @select="(bucket) => selectSegment(row.code, bucket)"
            />
            <div class="flex gap-2">
              <Button type="button" variant="outline" size="sm" :disabled="retryAction.pending.value || row.open === 0" @click="retryOpen(row.code)">
                <Loader2 v-if="retryAction.pending.value" class="h-4 w-4 animate-spin" />
                <RefreshCw v-else class="h-4 w-4" />
                {{ $t('settings.llmStatus.retryOpen') }}
              </Button>
              <Button type="button" variant="outline" size="sm" :disabled="retryAction.pending.value || row.error === 0" @click="retryFailed(row.code)">
                <Loader2 v-if="retryAction.pending.value" class="h-4 w-4 animate-spin" />
                <RefreshCw v-else class="h-4 w-4" />
                {{ $t('settings.llmStatus.retryFailed') }}
              </Button>
            </div>
          </div>

          <div v-if="selectedCountry === row.code" class="space-y-2 border-t bg-muted/20 px-3 py-3">
            <p v-if="listError" class="text-sm text-destructive">{{ listError }}</p>
            <Loader2 v-if="listPending" class="h-4 w-4 animate-spin text-muted-foreground" />
            <template v-else>
              <p v-if="list.items.length === 0" class="text-sm text-muted-foreground">{{ $t('settings.statusOverview.listEmpty') }}</p>
              <div v-else class="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{{ $t('settings.statusOverview.colPlatform') }}</TableHead>
                      <TableHead>{{ $t('settings.statusOverview.colTitle') }}</TableHead>
                      <TableHead>{{ $t('settings.statusOverview.colRegion') }}</TableHead>
                      <TableHead v-if="selectedBucket === 'error'">{{ $t('settings.llmStatus.colFailures') }}</TableHead>
                      <TableHead v-if="selectedBucket === 'error'">{{ $t('settings.statusOverview.colError') }}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="item in list.items" :key="`${item.platform}:${item.externalId}`">
                      <TableCell class="whitespace-nowrap font-mono text-xs">{{ item.platform }}</TableCell>
                      <TableCell class="max-w-xs truncate">
                        <NuxtLink :to="`/admin/auktion/${item.platform}/${item.externalId}`" class="hover:underline">
                          {{ item.title || item.caseNumber }}
                        </NuxtLink>
                      </TableCell>
                      <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ item.region }}</TableCell>
                      <TableCell v-if="selectedBucket === 'error'" class="text-xs tabular-nums text-muted-foreground">{{ item.llmFailures }}</TableCell>
                      <TableCell v-if="selectedBucket === 'error'" class="max-w-xs truncate text-xs text-destructive">
                        {{ item.lastErrorMessage }}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <div v-if="list.total > LIST_LIMIT" class="flex items-center justify-between text-xs text-muted-foreground">
                <span>{{ $t('settings.statusOverview.pageInfo', { from: offset + 1, to: Math.min(offset + LIST_LIMIT, list.total), total: list.total }) }}</span>
                <div class="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" :disabled="offset === 0" @click="changePage(-1)">{{ $t('settings.statusOverview.prevPage') }}</Button>
                  <Button type="button" variant="ghost" size="sm" :disabled="offset + LIST_LIMIT >= list.total" @click="changePage(1)">{{ $t('settings.statusOverview.nextPage') }}</Button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
    </CardContent>
  </Card>
</template>
