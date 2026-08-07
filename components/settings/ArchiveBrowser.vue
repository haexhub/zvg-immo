<script setup lang="ts">
import { ChevronLeft, Loader2, Trash2 } from 'lucide-vue-next'
import type { ArchiveCountryRow } from '~/server/api/settings/archive/countries.get'
import type { ArchiveRegionRow } from '~/server/api/settings/archive/regions.get'
import type { ArchiveCaseRow } from '~/server/api/settings/archive/cases.get'
import type { ArchiveDocumentRow } from '~/server/api/settings/archive/documents.get'
import type { DeleteRawArchiveCountryResult } from '~/server/utils/raw-archive-delete'
import { useSettingsError } from '~/composables/settings/useSettingsError'

type Level = 'country' | 'region' | 'case' | 'document'

const { t } = useI18n()
const intlLocale = useIntlLocale()
const { normalizeSettingsError } = useSettingsError()

const level = ref<Level>('country')
const selectedCountry = ref<{ code: string; label: string } | null>(null)
const selectedRegion = ref<string | null>(null)
const selectedCase = ref<ArchiveCaseRow | null>(null)

const countries = ref<ArchiveCountryRow[]>([])
const regions = ref<ArchiveRegionRow[]>([])
const cases = ref<ArchiveCaseRow[]>([])
const documents = ref<ArchiveDocumentRow[]>([])

const pending = ref(false)
const error = ref<string | null>(null)
const deleteCountryPending = ref<string | null>(null)
const deleteCountryResult = ref<DeleteRawArchiveCountryResult | null>(null)

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(intlLocale.value)
}

async function withLoading<T>(fn: () => Promise<T>): Promise<T | undefined> {
  pending.value = true
  error.value = null
  try {
    return await fn()
  } catch (err) {
    error.value = normalizeSettingsError(err, t('settings.archive.loadError'))
    return undefined
  } finally {
    pending.value = false
  }
}

const retry = ref<() => void>(() => loadCountries())

async function loadCountries(): Promise<void> {
  retry.value = () => loadCountries()
  const result = await withLoading(() => $fetch<ArchiveCountryRow[]>('/api/settings/archive/countries'))
  if (result) countries.value = result
}

async function openCountry(row: ArchiveCountryRow): Promise<void> {
  selectedCountry.value = { code: row.code, label: row.label }
  retry.value = () => openCountry(row)
  const result = await withLoading(() =>
    $fetch<ArchiveRegionRow[]>('/api/settings/archive/regions', { query: { country: row.code } }),
  )
  if (result) {
    regions.value = result
    level.value = 'region'
  }
}

async function deleteCountry(row: ArchiveCountryRow): Promise<void> {
  if (pending.value || deleteCountryPending.value) return
  const ok = window.confirm(t('settings.archive.deleteCountryConfirm', { country: row.label }))
  if (!ok) return

  deleteCountryPending.value = row.code
  deleteCountryResult.value = null
  error.value = null
  try {
    deleteCountryResult.value = await $fetch<DeleteRawArchiveCountryResult>(
      `/api/settings/archive/countries/${encodeURIComponent(row.code)}`,
      { method: 'DELETE' },
    )
    await loadCountries()
  } catch (err) {
    error.value = normalizeSettingsError(err, t('settings.archive.deleteCountryError'))
  } finally {
    deleteCountryPending.value = null
  }
}

async function openRegion(row: ArchiveRegionRow): Promise<void> {
  if (!selectedCountry.value) return
  selectedRegion.value = row.region
  retry.value = () => openRegion(row)
  const result = await withLoading(() =>
    $fetch<ArchiveCaseRow[]>('/api/settings/archive/cases', {
      query: { country: selectedCountry.value!.code, region: row.region },
    }),
  )
  if (result) {
    cases.value = result
    level.value = 'case'
  }
}

async function openCase(row: ArchiveCaseRow): Promise<void> {
  selectedCase.value = row
  retry.value = () => openCase(row)
  const result = await withLoading(() =>
    $fetch<ArchiveDocumentRow[]>('/api/settings/archive/documents', {
      query: { platform: row.platform, externalId: row.externalId },
    }),
  )
  if (result) {
    documents.value = result
    level.value = 'document'
  }
}

function goBack(): void {
  error.value = null
  if (level.value === 'document') level.value = 'case'
  else if (level.value === 'case') level.value = 'region'
  else if (level.value === 'region') level.value = 'country'
}

onMounted(loadCountries)
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground">
      {{ $t('settings.archive.description') }}
    </p>

    <div v-if="level !== 'country'" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Button type="button" variant="ghost" size="sm" @click="goBack">
        <ChevronLeft class="h-4 w-4" />
        {{ $t('settings.archive.back') }}
      </Button>
      <span v-if="selectedCountry">{{ selectedCountry.label }}</span>
      <span v-if="selectedRegion && level !== 'region'">/ {{ selectedRegion }}</span>
      <span v-if="selectedCase && level === 'document'">/ {{ selectedCase.caseLabel }}</span>
    </div>

    <div v-if="error" class="flex items-center gap-2 text-sm text-destructive">
      <span>{{ error }}</span>
      <Button type="button" variant="ghost" size="sm" @click="retry()">
        {{ $t('settings.archive.retry') }}
      </Button>
    </div>
    <p v-if="deleteCountryResult" class="text-sm text-emerald-600 dark:text-emerald-500">
      {{ $t('settings.archive.deleteCountryDone', {
        country: deleteCountryResult.country.toUpperCase(),
        captures: deleteCountryResult.deleted.captures,
        sets: deleteCountryResult.deleted.documentSets,
        blobs: deleteCountryResult.deleted.blobs,
      }) }}
    </p>
    <p v-if="pending" class="text-sm text-muted-foreground">{{ $t('settings.archive.loading') }}</p>

    <template v-if="level === 'country'">
      <Table v-if="countries.length" class="min-w-[520px]">
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t('settings.archive.colCountry') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colCount') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colLast') }}</TableHead>
            <TableHead class="text-right">{{ $t('settings.archive.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="c in countries" :key="c.code">
            <TableCell>{{ c.label }}</TableCell>
            <TableCell class="tabular-nums">{{ c.count }}</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ formatDate(c.lastCapturedAt) }}</TableCell>
            <TableCell class="text-right">
              <div class="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" :disabled="deleteCountryPending !== null" @click="openCountry(c)">
                  {{ $t('settings.archive.open') }}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  :title="$t('settings.archive.deleteCountry')"
                  :aria-label="$t('settings.archive.deleteCountry')"
                  :disabled="pending || deleteCountryPending !== null"
                  @click="deleteCountry(c)"
                >
                  <Loader2 v-if="deleteCountryPending === c.code" class="h-4 w-4 animate-spin" />
                  <Trash2 v-else class="h-4 w-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-else class="text-sm text-muted-foreground">{{ $t('settings.archive.empty') }}</p>
    </template>

    <template v-else-if="level === 'region'">
      <Table v-if="regions.length" class="min-w-[520px]">
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t('settings.archive.colRegion') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colCount') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colLast') }}</TableHead>
            <TableHead class="text-right">{{ $t('settings.archive.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="r in regions" :key="r.region">
            <TableCell>{{ r.region }}</TableCell>
            <TableCell class="tabular-nums">{{ r.count }}</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ formatDate(r.lastCapturedAt) }}</TableCell>
            <TableCell class="text-right">
              <Button type="button" variant="outline" size="sm" @click="openRegion(r)">
                {{ $t('settings.archive.open') }}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-else class="text-sm text-muted-foreground">{{ $t('settings.archive.empty') }}</p>
    </template>

    <template v-else-if="level === 'case'">
      <Table v-if="cases.length" class="min-w-[640px]">
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t('settings.archive.colCase') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colAuthority') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colCount') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colLast') }}</TableHead>
            <TableHead class="text-right">{{ $t('settings.archive.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="c in cases" :key="`${c.platform}:${c.externalId}`">
            <TableCell>{{ c.caseLabel }}</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ c.authority ?? '–' }}</TableCell>
            <TableCell class="tabular-nums">{{ c.count }}</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ formatDate(c.lastCapturedAt) }}</TableCell>
            <TableCell class="text-right">
              <Button type="button" variant="outline" size="sm" @click="openCase(c)">
                {{ $t('settings.archive.open') }}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-else class="text-sm text-muted-foreground">{{ $t('settings.archive.empty') }}</p>
    </template>

    <template v-else-if="level === 'document'">
      <Table v-if="documents.length" class="min-w-[640px]">
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t('settings.archive.colVersion') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colKind') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colDocument') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colType') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colSize') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colLast') }}</TableHead>
            <TableHead class="text-right">{{ $t('settings.archive.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="d in documents" :key="d.id">
            <TableCell class="tabular-nums">
              {{ d.setVersion ? `v${d.setVersion}` : '–' }}
            </TableCell>
            <TableCell>{{ $t(`settings.archive.kind.${d.kind}`) }}</TableCell>
            <TableCell class="max-w-[220px] truncate text-xs text-muted-foreground">
              {{ d.label || d.filename || d.sourceUrl || '–' }}
            </TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ d.contentType }}</TableCell>
            <TableCell class="tabular-nums">{{ (d.byteSize / 1024).toFixed(0) }} KB</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ formatDate(d.capturedAt) }}</TableCell>
            <TableCell class="text-right">
              <a
                :href="`/api/settings/archive/download/${d.id}`"
                download
                target="_blank"
                class="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
              >
                {{ $t('settings.archive.download') }}
              </a>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-else class="text-sm text-muted-foreground">{{ $t('settings.archive.empty') }}</p>
    </template>
  </div>
</template>
