<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'
import type { ArchiveCountryRow } from '~/server/api/settings/archive/countries.get'
import type { ArchiveRegionRow } from '~/server/api/settings/archive/regions.get'
import type { ArchiveCaseRow } from '~/server/api/settings/archive/cases.get'
import type { ArchiveDocumentRow } from '~/server/api/settings/archive/documents.get'

type Level = 'country' | 'region' | 'case' | 'document'

const { t } = useI18n()
const intlLocale = useIntlLocale()

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(intlLocale.value)
}

async function loadCountries(): Promise<void> {
  pending.value = true
  error.value = null
  try {
    countries.value = await $fetch<ArchiveCountryRow[]>('/api/settings/archive/countries')
  } catch {
    error.value = t('settings.archive.loadError')
  } finally {
    pending.value = false
  }
}

async function openCountry(row: ArchiveCountryRow): Promise<void> {
  selectedCountry.value = { code: row.code, label: row.label }
  pending.value = true
  error.value = null
  try {
    regions.value = await $fetch<ArchiveRegionRow[]>('/api/settings/archive/regions', {
      query: { country: row.code },
    })
    level.value = 'region'
  } catch {
    error.value = t('settings.archive.loadError')
  } finally {
    pending.value = false
  }
}

async function openRegion(row: ArchiveRegionRow): Promise<void> {
  if (!selectedCountry.value) return
  selectedRegion.value = row.region
  pending.value = true
  error.value = null
  try {
    cases.value = await $fetch<ArchiveCaseRow[]>('/api/settings/archive/cases', {
      query: { country: selectedCountry.value.code, region: row.region },
    })
    level.value = 'case'
  } catch {
    error.value = t('settings.archive.loadError')
  } finally {
    pending.value = false
  }
}

async function openCase(row: ArchiveCaseRow): Promise<void> {
  selectedCase.value = row
  pending.value = true
  error.value = null
  try {
    documents.value = await $fetch<ArchiveDocumentRow[]>('/api/settings/archive/documents', {
      query: { platform: row.platform, externalId: row.externalId },
    })
    level.value = 'document'
  } catch {
    error.value = t('settings.archive.loadError')
  } finally {
    pending.value = false
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

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <p v-else-if="pending" class="text-sm text-muted-foreground">{{ $t('settings.archive.loading') }}</p>

    <template v-else-if="level === 'country'">
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
              <Button type="button" variant="outline" size="sm" @click="openCountry(c)">
                {{ $t('settings.archive.open') }}
              </Button>
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
            <TableHead>{{ $t('settings.archive.colKind') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colType') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colSize') }}</TableHead>
            <TableHead>{{ $t('settings.archive.colLast') }}</TableHead>
            <TableHead class="text-right">{{ $t('settings.archive.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="d in documents" :key="d.id">
            <TableCell>{{ $t(`settings.archive.kind.${d.kind}`) }}</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ d.contentType }}</TableCell>
            <TableCell class="tabular-nums">{{ (d.byteSize / 1024).toFixed(0) }} KB</TableCell>
            <TableCell class="text-xs text-muted-foreground">{{ formatDate(d.capturedAt) }}</TableCell>
            <TableCell class="text-right">
              <a
                :href="`/api/settings/archive/download/${d.id}`"
                download
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
