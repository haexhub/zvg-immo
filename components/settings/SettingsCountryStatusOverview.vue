<script setup lang="ts">
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, RefreshCw, Search } from 'lucide-vue-next'
import type { OsmImportCountryStatus } from '~/server/api/settings/osm-import.get'
import type { StatusBucket, StatusCounts, StatusList, StatusListItem } from '~/composables/settings/useSettingsStatusOverview'
import type { StatusPieSegment } from './SettingsStatusPie.client.vue'
import SettingsStatusPie from './SettingsStatusPie.client.vue'
import SettingsAutomationControlsCard from './SettingsAutomationControlsCard.vue'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'
import { usePollWhileActive } from '~/composables/settings/usePollWhileActive'

type ProcessingStatusKind = 'crawl' | 'llm' | 'translation'
type StatusKind = ProcessingStatusKind | 'osm'
type TableSort = 'platform' | 'title' | 'region' | 'error' | 'lang' | 'failures' | 'startedAt'

const PAGE_SIZE = 25
const EMPTY_COUNTS: StatusCounts = { done: 0, open: 0, error: 0, total: 0 }
const STATUS_COLORS = { done: '#0ca30c', open: '#fab219', error: '#d03b3b' } as const

const { t } = useI18n()
const countryLabel = useCountryLabel()
const { normalizeSettingsError } = useSettingsError()
const { startProgressPolling, formatBatchDate } = useSettingsTaskOverview()

// retryTranslationsBulk (server/utils/translation-retry.ts) runs detached and
// exposes no running/idle status endpoint, unlike enrich/reprocess. There is
// nothing to check for "still active", so this only bounds the window via
// maxAttempts — same shape as the OSM import polling below.
const { start: startTranslationRetryPolling } = usePollWhileActive(
  () => true,
  async () => { await Promise.all([load(), loadList()]) },
  { intervalMs: 3000, maxAttempts: 10 },
)

const counts = ref<Record<ProcessingStatusKind, Record<string, StatusCounts>>>({ crawl: {}, llm: {}, translation: {} })
const osmByCountry = ref<Record<string, OsmImportCountryStatus>>({})
const pending = ref(false)
const loadError = ref<string | null>(null)
const actionPending = ref<string | null>(null)
const actionError = ref<string | null>(null)

const selected = ref<{ country: string; kind: StatusKind; bucket: StatusBucket } | null>(null)
const list = ref<StatusList>({ items: [], total: 0 })
const listPending = ref(false)
const listError = ref<string | null>(null)
const tableOffset = ref(0)
const tableSearch = ref('')
const tableSort = ref<TableSort>('platform')
const tableDirection = ref<'asc' | 'desc'>('asc')
// Derived from `selected` instead of its own ref: the Accordion can close
// itself (clicking an open trigger) without going through selectSegment(),
// which left `selected` and this out of sync — the pie stayed highlighted
// with the table closed, and the next click on that segment only cleared
// the highlight instead of reopening the table.
const tableAccordion = computed<string>({
  get: () => (selected.value ? 'status-table' : ''),
  set: (value) => {
    if (!value) selected.value = null
  },
})
let filterTimer: ReturnType<typeof setTimeout> | undefined
let listRequestId = 0

const countryCodes = computed(() => {
  const all = new Set([
    ...Object.keys(counts.value.crawl),
    ...Object.keys(counts.value.llm),
    ...Object.keys(counts.value.translation),
    ...Object.keys(osmByCountry.value),
  ])
  return [...all].sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)))
})

const activeCountry = ref('')

watch(countryCodes, (codes) => {
  if (codes.length === 0) activeCountry.value = ''
  else if (!codes.includes(activeCountry.value)) activeCountry.value = codes[0] ?? ''
}, { immediate: true })

const bucketLabels = computed<Record<StatusBucket, string>>(() => ({
  done: t('settings.statusOverview.bucketDone'),
  open: t('settings.statusOverview.bucketOpen'),
  error: t('settings.statusOverview.bucketError'),
}))

const selectedStatusLabel = computed(() => {
  const target = selected.value
  if (!target) return ''
  if (target.kind === 'osm') return osmSegments(target.country).find((segment) => segment.key === target.bucket)?.label ?? ''
  return bucketLabels.value[target.bucket]
})

function statusSegments(kind: ProcessingStatusKind, country: string): StatusPieSegment[] {
  const row = counts.value[kind][country] ?? EMPTY_COUNTS
  return (['done', 'open', 'error'] as const).map((bucket) => ({
    key: bucket,
    label: bucketLabels.value[bucket],
    color: STATUS_COLORS[bucket],
    value: row[bucket],
  }))
}

function osmSegments(country: string): StatusPieSegment[] {
  const osm = osmByCountry.value[country]
  return [
    { key: 'done', label: t('settings.countryOverview.osmAttached'), color: STATUS_COLORS.done, value: osm?.attachedAuctions ?? 0 },
    { key: 'open', label: t('settings.countryOverview.osmOpen'), color: STATUS_COLORS.open, value: osm?.openAuctions ?? 0 },
    { key: 'error', label: t('settings.countryOverview.osmBlocked'), color: STATUS_COLORS.error, value: osm?.errorAuctions ?? 0 },
  ]
}

async function load(): Promise<void> {
  pending.value = true
  loadError.value = null
  try {
    const [crawl, llm, translation, osm] = await Promise.all([
      $fetch<Record<string, StatusCounts>>('/api/settings/crawl-status'),
      $fetch<Record<string, StatusCounts>>('/api/settings/llm-status'),
      $fetch<Record<string, StatusCounts>>('/api/settings/translation-status'),
      $fetch<{ countries: OsmImportCountryStatus[] }>('/api/settings/osm-import'),
    ])
    counts.value = { crawl, llm, translation }
    osmByCountry.value = Object.fromEntries(osm.countries.map((country) => [country.code, country]))
  } catch (err) {
    loadError.value = normalizeSettingsError(err, t('settings.statusOverview.loadError'))
  } finally {
    pending.value = false
  }
}

// The reimport itself does not run in this app: [country].post.ts only
// records the request, and the host-level daily job clears it once it
// starts honoring it. `requestedAt` therefore stays set for hours, so this
// must not poll open-endedly — bounded to a short window right after a
// manual request, the only moment the row count can plausibly move while an
// admin is watching (see SettingsOsmImportCard.vue, which this replaces).
const { start: startOsmPolling } = usePollWhileActive(
  () => Object.values(osmByCountry.value).some((country) => !!country.requestedAt),
  load,
  { intervalMs: 30_000, maxAttempts: 20 },
)

function selectedBucket(country: string, kind: StatusKind): StatusBucket | null {
  return selected.value?.country === country && selected.value.kind === kind ? selected.value.bucket : null
}

async function loadList(): Promise<void> {
  const target = selected.value
  if (!target) return
  const requestId = ++listRequestId
  listPending.value = true
  listError.value = null
  try {
    const result = await $fetch<StatusList>(`/api/settings/${target.kind}-status/${target.country}`, {
      query: {
        bucket: target.bucket,
        limit: PAGE_SIZE,
        offset: tableOffset.value,
        search: tableSearch.value || undefined,
        sort: tableSort.value,
        direction: tableDirection.value,
      },
    })
    if (requestId !== listRequestId) return
    list.value = result
  } catch (err) {
    if (requestId !== listRequestId) return
    listError.value = normalizeSettingsError(err, t('settings.statusOverview.listLoadError'))
  } finally {
    if (requestId === listRequestId) listPending.value = false
  }
}

function selectSegment(country: string, kind: StatusKind, bucket: string): void {
  const statusBucket = bucket as StatusBucket
  if (selected.value?.country === country && selected.value.kind === kind && selected.value.bucket === statusBucket) {
    selected.value = null
    return
  }
  // Sort fields are kind-specific: `lang`/`startedAt` are translation-only and
  // `failures` is LLM-only. Carrying one over to another kind makes the
  // endpoint reject the request with 400.
  if (selected.value?.kind !== kind) {
    tableSort.value = 'platform'
    tableDirection.value = 'asc'
  }
  selected.value = { country, kind, bucket: statusBucket }
  tableOffset.value = 0
  clearTimeout(filterTimer)
  tableSearch.value = ''
  void loadList()
}

async function runBulkRetry(country: string, kind: StatusKind, bucket: 'open' | 'error'): Promise<void> {
  const key = `${country}:${kind}:${bucket}`
  actionPending.value = key
  actionError.value = null
  try {
    if (kind === 'crawl') {
      startProgressPolling()
      await $fetch(`/api/settings/countries/${country}/${bucket === 'open' ? 'enrich-backlog' : 'enrich-retry-failed'}`, { method: 'POST' })
    } else if (kind === 'llm') {
      startProgressPolling()
      await $fetch(`/api/settings/countries/${country}/${bucket === 'open' ? 'reprocess-backlog' : 'reprocess-retry-failed'}`, { method: 'POST' })
    } else if (kind === 'translation') {
      await $fetch(`/api/settings/countries/${country}/${bucket === 'open' ? 'translation-retry-open' : 'translation-retry-failed'}`, { method: 'POST' })
      startTranslationRetryPolling()
    } else if (bucket === 'open') {
      await $fetch(`/api/settings/osm-enrichment/${country}`, { method: 'POST' })
      startProgressPolling()
    } else {
      await $fetch(`/api/settings/osm-import/${country}`, { method: 'POST' })
      startOsmPolling()
    }
    await load()
  } catch (err) {
    actionError.value = normalizeSettingsError(err, t('settings.statusOverview.retryError'))
  } finally {
    actionPending.value = null
  }
}

async function retryItem(item: StatusListItem): Promise<void> {
  const target = selected.value
  if (!target || actionPending.value) return
  actionPending.value = `item:${item.platform}:${item.externalId}:${item.lang ?? ''}`
  actionError.value = null
  try {
    if (target.kind === 'crawl') {
      startProgressPolling()
      await $fetch(`/api/settings/auction/${item.platform}/${item.externalId}/enrich-retry`, { method: 'POST' })
    } else if (target.kind === 'llm') {
      startProgressPolling()
      await $fetch(`/api/settings/auction/${item.platform}/${item.externalId}/reprocess-retry`, { method: 'POST' })
    } else if (target.kind === 'translation') {
      await $fetch(`/api/settings/auction/${item.platform}/${item.externalId}/translation-retry`, { method: 'POST', body: { lang: item.lang } })
    } else {
      await $fetch(`/api/settings/osm-enrichment/${target.country}`, { method: 'POST', body: { platform: item.platform, externalId: item.externalId } })
      startProgressPolling()
    }
    await Promise.all([loadList(), load()])
  } catch (err) {
    actionError.value = normalizeSettingsError(err, t('settings.statusOverview.retryError'))
  } finally {
    actionPending.value = null
  }
}

function setSort(sort: TableSort): void {
  if (tableSort.value === sort) tableDirection.value = tableDirection.value === 'asc' ? 'desc' : 'asc'
  else {
    tableSort.value = sort
    tableDirection.value = 'asc'
  }
  tableOffset.value = 0
  void loadList()
}

function sortIcon(sort: TableSort) {
  if (tableSort.value !== sort) return ArrowUpDown
  return tableDirection.value === 'asc' ? ArrowUp : ArrowDown
}

function changePage(step: number): void {
  tableOffset.value = Math.max(0, tableOffset.value + step * PAGE_SIZE)
  void loadList()
}

watch(tableSearch, () => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    tableOffset.value = 0
    void loadList()
  }, 250)
})

onMounted(load)
onBeforeUnmount(() => clearTimeout(filterTimer))
</script>

<template>
  <section class="space-y-4">
    <SettingsAutomationControlsCard />
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-muted-foreground">{{ $t('settings.sections.status') }}</h2>
        <p class="mt-1 text-sm text-muted-foreground">{{ $t('settings.countryOverview.description') }}</p>
      </div>
      <Button type="button" variant="outline" size="sm" :disabled="pending" @click="load">
        <Loader2 v-if="pending" class="h-4 w-4 animate-spin" />
        <RefreshCw v-else class="h-4 w-4" />
        {{ $t('settings.crawlStatus.refresh') }}
      </Button>
    </div>

    <p v-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>
    <p v-if="actionError" class="text-sm text-destructive">{{ actionError }}</p>
    <p v-if="!pending && countryCodes.length === 0" class="text-sm text-muted-foreground">{{ $t('settings.crawlStatus.empty') }}</p>

    <Tabs v-if="countryCodes.length > 0" v-model="activeCountry">
      <TabsList class="h-auto w-full flex-wrap justify-start gap-1">
        <TabsTrigger v-for="country in countryCodes" :key="country" :value="country" class="gap-1.5">
          {{ countryLabel(country) }}
          <span class="font-mono text-xs uppercase opacity-70">{{ country }}</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent v-for="country in countryCodes" :key="country" :value="country">
        <Card class="overflow-visible">
          <CardContent class="space-y-5">
            <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <section v-for="kind in (['crawl', 'llm', 'translation'] as ProcessingStatusKind[])" :key="kind" class="flex min-w-0 flex-col rounded-lg border bg-muted/15 p-4">
                <h3 class="mb-3 text-sm font-semibold">
                  {{ kind === 'crawl' ? $t('settings.crawlStatus.title') : kind === 'llm' ? $t('settings.llmStatus.title') : $t('settings.translationStatus.title') }}
                </h3>
                <SettingsStatusPie
                  :segments="statusSegments(kind, country)"
                  :selected="selectedBucket(country, kind)"
                  :size="208"
                  @select="(bucket) => selectSegment(country, kind, bucket)"
                />
                <div class="mt-4 grid gap-2">
                  <Button type="button" variant="outline" size="sm" :disabled="actionPending !== null || (counts[kind][country]?.open ?? 0) === 0" @click="runBulkRetry(country, kind, 'open')">
                    <Loader2 v-if="actionPending === `${country}:${kind}:open`" class="h-4 w-4 animate-spin" />
                    <RefreshCw v-else class="h-4 w-4" />
                    {{ kind === 'crawl' ? $t('settings.crawlStatus.retryOpen') : kind === 'llm' ? $t('settings.llmStatus.retryOpen') : $t('settings.translationStatus.retryOpen') }}
                  </Button>
                  <Button type="button" variant="outline" size="sm" :disabled="actionPending !== null || (counts[kind][country]?.error ?? 0) === 0" @click="runBulkRetry(country, kind, 'error')">
                    <Loader2 v-if="actionPending === `${country}:${kind}:error`" class="h-4 w-4 animate-spin" />
                    <RefreshCw v-else class="h-4 w-4" />
                    {{ kind === 'crawl' ? $t('settings.crawlStatus.retryFailed') : kind === 'llm' ? $t('settings.llmStatus.retryFailed') : $t('settings.translationStatus.retryFailed') }}
                  </Button>
                </div>
              </section>

              <section class="flex min-w-0 flex-col rounded-lg border bg-muted/15 p-4">
                <h3 class="mb-3 text-sm font-semibold">{{ $t('settings.osmImport.title') }}</h3>
                <SettingsStatusPie :segments="osmSegments(country)" :selected="selectedBucket(country, 'osm')" :size="208" @select="(bucket) => selectSegment(country, 'osm', bucket)" />
                <p class="mt-3 min-h-10 text-center text-xs text-muted-foreground">
                  <template v-if="osmByCountry[country]?.requestedAt">{{ $t('settings.osmImport.pending', { at: formatBatchDate(osmByCountry[country].requestedAt!) }) }}</template>
                  <template v-else>{{ $t('settings.osmImport.rawRowCount', { count: osmByCountry[country]?.rowCount ?? 0 }) }}</template>
                </p>
                <div class="mt-4 grid gap-2">
                  <Button type="button" variant="outline" size="sm" :disabled="actionPending !== null || (osmByCountry[country]?.openAuctions ?? 0) === 0" @click="runBulkRetry(country, 'osm', 'open')">
                    <Loader2 v-if="actionPending === `${country}:osm:open`" class="h-4 w-4 animate-spin" />
                    <RefreshCw v-else class="h-4 w-4" />
                    {{ $t('settings.osmImport.loadOpen') }}
                  </Button>
                  <Button type="button" variant="outline" size="sm" :disabled="actionPending !== null || (osmByCountry[country]?.errorAuctions ?? 0) === 0" @click="runBulkRetry(country, 'osm', 'error')">
                    <Loader2 v-if="actionPending === `${country}:osm:error`" class="h-4 w-4 animate-spin" />
                    <RefreshCw v-else class="h-4 w-4" />
                    {{ $t('settings.osmImport.retryBlocked') }}
                  </Button>
                </div>
              </section>
            </div>

            <Accordion v-if="selected?.country === country" v-model="tableAccordion" type="single" collapsible class="rounded-md border px-4">
              <AccordionItem value="status-table" class="border-b-0">
                <AccordionTrigger class="py-4 hover:no-underline">
                  {{ $t('settings.countryOverview.tableTitle', { status: selectedStatusLabel }) }}
                </AccordionTrigger>
                <AccordionContent class="pb-4">
                  <div class="mb-3 flex flex-wrap items-center gap-2">
                    <div class="relative min-w-56 flex-1">
                      <Search class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input v-model="tableSearch" :placeholder="$t('settings.countryOverview.filterPlaceholder')" class="pl-8" />
                    </div>
                    <span class="text-xs text-muted-foreground">{{ $t('settings.countryOverview.filterHint') }}</span>
                  </div>
                  <p v-if="listError" class="mb-3 text-sm text-destructive">{{ listError }}</p>
                  <Loader2 v-if="listPending" class="m-4 h-5 w-5 animate-spin text-muted-foreground" />
                  <template v-else>
                    <p v-if="list.items.length === 0" class="text-sm text-muted-foreground">{{ $t('settings.statusOverview.listEmpty') }}</p>
                    <div v-else class="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead><button type="button" class="inline-flex items-center gap-1 hover:text-foreground" @click="setSort('platform')">{{ $t('settings.statusOverview.colPlatform') }}<component :is="sortIcon('platform')" class="h-3.5 w-3.5" /></button></TableHead>
                            <TableHead><button type="button" class="inline-flex items-center gap-1 hover:text-foreground" @click="setSort('title')">{{ $t('settings.statusOverview.colTitle') }}<component :is="sortIcon('title')" class="h-3.5 w-3.5" /></button></TableHead>
                            <TableHead><button type="button" class="inline-flex items-center gap-1 hover:text-foreground" @click="setSort('region')">{{ $t('settings.statusOverview.colRegion') }}<component :is="sortIcon('region')" class="h-3.5 w-3.5" /></button></TableHead>
                            <TableHead v-if="selected?.kind === 'translation'"><button type="button" class="inline-flex items-center gap-1 hover:text-foreground" @click="setSort('lang')">{{ $t('settings.translationStatus.colLang') }}<component :is="sortIcon('lang')" class="h-3.5 w-3.5" /></button></TableHead>
                            <TableHead v-if="selected?.kind === 'llm' && selected.bucket === 'error'"><button type="button" class="inline-flex items-center gap-1 hover:text-foreground" @click="setSort('failures')">{{ $t('settings.llmStatus.colFailures') }}<component :is="sortIcon('failures')" class="h-3.5 w-3.5" /></button></TableHead>
                            <TableHead v-if="selected?.bucket === 'error'"><template v-if="selected?.kind === 'llm'">{{ $t('settings.statusOverview.colError') }}</template><button v-else type="button" class="inline-flex items-center gap-1 hover:text-foreground" @click="setSort('error')">{{ $t('settings.statusOverview.colError') }}<component :is="sortIcon('error')" class="h-3.5 w-3.5" /></button></TableHead>
                            <TableHead class="w-10" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow v-for="item in list.items" :key="`${item.platform}:${item.externalId}:${item.lang ?? ''}`">
                            <TableCell class="whitespace-nowrap font-mono text-xs">{{ item.platform }}</TableCell>
                            <TableCell class="max-w-xs truncate"><NuxtLink :to="`/admin/auktion/${item.platform}/${item.externalId}`" class="hover:underline">{{ item.title || item.caseNumber }}</NuxtLink></TableCell>
                            <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ item.region }}</TableCell>
                            <TableCell v-if="selected?.kind === 'translation'" class="font-mono text-xs uppercase">{{ item.lang }}</TableCell>
                            <TableCell v-if="selected?.kind === 'llm' && selected.bucket === 'error'" class="text-xs tabular-nums">{{ item.llmFailures }}</TableCell>
                            <TableCell v-if="selected?.bucket === 'error'" class="max-w-md whitespace-normal break-words text-xs text-destructive">{{ item.lastErrorMessage }}</TableCell>
                            <TableCell class="text-right"><Button v-if="selected?.kind !== 'osm' || selected.bucket === 'open'" type="button" variant="ghost" size="icon-sm" :disabled="actionPending !== null" :title="$t('settings.countryOverview.retryRow')" @click="retryItem(item)"><Loader2 v-if="actionPending === `item:${item.platform}:${item.externalId}:${item.lang ?? ''}`" class="h-4 w-4 animate-spin" /><RefreshCw v-else class="h-4 w-4" /></Button></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                    <div v-if="list.total > PAGE_SIZE" class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{{ $t('settings.statusOverview.pageInfo', { from: tableOffset + 1, to: Math.min(tableOffset + PAGE_SIZE, list.total), total: list.total }) }}</span>
                      <div class="flex gap-2"><Button type="button" variant="ghost" size="sm" :disabled="tableOffset === 0" @click="changePage(-1)">{{ $t('settings.statusOverview.prevPage') }}</Button><Button type="button" variant="ghost" size="sm" :disabled="tableOffset + PAGE_SIZE >= list.total" @click="changePage(1)">{{ $t('settings.statusOverview.nextPage') }}</Button></div>
                    </div>
                  </template>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  </section>
</template>
