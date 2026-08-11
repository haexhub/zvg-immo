<script setup lang="ts">
// Shared layout for the /settings crawl-, LLM- and translation-status donut
// cards: donut, bulk open/failed retry, drill-down table and single-row
// retry always sit in the same place regardless of which one is rendered.
// Each caller only supplies its own copy, its own retry endpoints (via the
// onRetry* callback props) and, where the data actually differs (LLM's
// Fehlversuche count, translation's Sprache), extra table columns via slots.
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsAction } from '~/composables/settings/useSettingsAction'
import { useSettingsStatusOverview, type StatusBucket, type StatusListItem } from '~/composables/settings/useSettingsStatusOverview'

const props = defineProps<{
  kind: 'crawl' | 'llm' | 'translation'
  title: string
  description: string
  refreshLabel: string
  emptyLabel: string
  retryOpenLabel: string
  retryFailedLabel: string
  retryRowLabel: string
  onRetryOpen: (code: string) => Promise<void>
  onRetryFailed: (code: string) => Promise<void>
  onRetryItem: (item: StatusListItem) => Promise<void>
}>()

const { t } = useI18n()
const { rows, pending, error, load, list, listPending, listError, loadList, clearList, LIST_LIMIT } = useSettingsStatusOverview(props.kind)

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

// Shared across every country row's two buttons (same simplification the
// pre-unification cards already made): one bulk retry in flight at a time,
// bulkTarget just tracks which button gets the spinner.
const bulkAction = useSettingsAction()
const bulkTarget = ref<string | null>(null)
async function runBulkRetry(bucket: 'open' | 'failed', code: string): Promise<void> {
  bulkTarget.value = `${code}:${bucket}`
  await bulkAction.run(async () => {
    if (bucket === 'open') await props.onRetryOpen(code)
    else await props.onRetryFailed(code)
    await load()
  }, 'settings.statusOverview.retryError')
  bulkTarget.value = null
}

function rowKey(item: StatusListItem): string {
  return `${item.platform}:${item.externalId}:${item.lang ?? ''}`
}

const retryingKey = ref<string | null>(null)
const retryItemError = ref<string | null>(null)
async function retryItem(item: StatusListItem): Promise<void> {
  if (retryingKey.value) return
  retryingKey.value = rowKey(item)
  retryItemError.value = null
  try {
    await props.onRetryItem(item)
    if (selectedCountry.value && selectedBucket.value) await loadList(selectedCountry.value, selectedBucket.value, offset.value)
    await load()
  } catch (err) {
    retryItemError.value = err instanceof Error ? err.message : t('settings.statusOverview.retryError')
  } finally {
    retryingKey.value = null
  }
}

onMounted(load)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ title }}</CardTitle>
      <CardAction>
        <Button type="button" variant="ghost" size="icon-sm" :disabled="pending" :title="refreshLabel" @click="load">
          <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ description }}</p>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="bulkAction.error.value" class="text-sm text-destructive">{{ bulkAction.error.value }}</p>
      <p v-if="retryItemError" class="text-sm text-destructive">{{ retryItemError }}</p>
      <p v-if="!pending && rows.length === 0" class="text-sm text-muted-foreground">{{ emptyLabel }}</p>

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
            <div class="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                :disabled="bulkAction.pending.value || row.open === 0"
                @click="runBulkRetry('open', row.code)"
              >
                <Loader2 v-if="bulkAction.pending.value && bulkTarget === `${row.code}:open`" class="h-4 w-4 animate-spin" />
                <RefreshCw v-else class="h-4 w-4" />
                {{ retryOpenLabel }}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                :disabled="bulkAction.pending.value || row.error === 0"
                @click="runBulkRetry('failed', row.code)"
              >
                <Loader2 v-if="bulkAction.pending.value && bulkTarget === `${row.code}:failed`" class="h-4 w-4 animate-spin" />
                <RefreshCw v-else class="h-4 w-4" />
                {{ retryFailedLabel }}
              </Button>
            </div>
          </div>

          <div v-if="selectedCountry === row.code" class="space-y-2 border-t bg-muted/20 px-3 py-3">
            <p v-if="listError" class="text-sm text-destructive">{{ listError }}</p>
            <Loader2 v-if="listPending" class="h-4 w-4 animate-spin text-muted-foreground" />
            <template v-else>
              <p v-if="list.items.length === 0" class="text-sm text-muted-foreground">{{ $t('settings.statusOverview.listEmpty') }}</p>
              <div v-else class="max-h-96 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{{ $t('settings.statusOverview.colPlatform') }}</TableHead>
                      <TableHead>{{ $t('settings.statusOverview.colTitle') }}</TableHead>
                      <TableHead>{{ $t('settings.statusOverview.colRegion') }}</TableHead>
                      <slot name="extra-columns" :bucket="selectedBucket" />
                      <TableHead v-if="selectedBucket === 'error'">{{ $t('settings.statusOverview.colError') }}</TableHead>
                      <TableHead class="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="item in list.items" :key="rowKey(item)">
                      <TableCell class="whitespace-nowrap font-mono text-xs">{{ item.platform }}</TableCell>
                      <TableCell class="max-w-xs truncate">
                        <NuxtLink :to="`/admin/auktion/${item.platform}/${item.externalId}`" class="hover:underline">
                          {{ item.title || item.caseNumber }}
                        </NuxtLink>
                      </TableCell>
                      <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ item.region }}</TableCell>
                      <slot name="extra-cells" :item="item" :bucket="selectedBucket" />
                      <TableCell v-if="selectedBucket === 'error'" class="max-w-md whitespace-normal break-words text-xs text-destructive">
                        {{ item.lastErrorMessage }}
                      </TableCell>
                      <TableCell class="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          :title="retryRowLabel"
                          :disabled="retryingKey !== null"
                          @click="retryItem(item)"
                        >
                          <Loader2 v-if="retryingKey === rowKey(item)" class="h-4 w-4 animate-spin" />
                          <RefreshCw v-else class="h-4 w-4" />
                        </Button>
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
