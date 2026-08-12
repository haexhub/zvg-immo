<script setup lang="ts">
import type { AuctionExtractionRunRow } from '~/server/utils/auction-technical'
import { formatCost } from '~/lib/auction-technical-helpers'

// A live Testlauf gets a synthetic 'pending' row (see [id].vue) that never
// reaches the server — the server-side type only knows 'success'/'failed'.
export type DisplayRunRow = Omit<AuctionExtractionRunRow, 'status'> & { status: AuctionExtractionRunRow['status'] | 'pending' }

const props = defineProps<{
  rows: DisplayRunRow[]
  selectedVersions: Set<number>
  promotePending: number | null
  formatDate: (value: string | null) => string
}>()
const emit = defineEmits<{
  'toggle-version': [version: number]
  promote: [version: number]
}>()

const { locale } = useI18n()
const formatTokens = (input: number | null, output: number | null): string =>
  input == null && output == null ? '—' : `${input ?? '—'} / ${output ?? '—'}`
</script>

<template>
  <Table v-if="props.rows.length">
    <TableHeader>
      <TableRow>
        <TableHead />
        <TableHead>{{ $t('settings.auctionTechnical.fields.version') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.status') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.provider') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.runTrigger') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.duration') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.tokens') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.cost') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.confidence') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.createdAt') }}</TableHead>
        <TableHead>{{ $t('settings.auctionTechnical.fields.error') }}</TableHead>
        <TableHead />
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow v-for="row in props.rows" :key="row.id">
        <TableCell>
          <Checkbox
            v-if="row.version != null"
            :model-value="props.selectedVersions.has(row.version)"
            :aria-label="`${$t('settings.auctionTechnical.fields.version')}: ${row.version}`"
            @update:model-value="() => emit('toggle-version', row.version!)"
          />
        </TableCell>
        <TableCell>{{ row.version ?? '—' }}</TableCell>
        <TableCell class="space-x-1">
          <Badge v-if="row.status === 'pending'" variant="secondary">{{ $t('settings.auctionTechnical.badges.pending') }}</Badge>
          <Badge v-if="row.status === 'failed'" variant="destructive">{{ $t('settings.auctionTechnical.badges.failed') }}</Badge>
          <Badge v-if="row.isLatest" variant="default">{{ $t('settings.auctionTechnical.badges.live') }}</Badge>
          <Badge v-if="row.isTrial" variant="secondary">{{ $t('settings.auctionTechnical.badges.trial') }}</Badge>
        </TableCell>
        <TableCell>{{ row.llmProvider ? `${row.llmProvider}/${row.llmModel}` : (row.extractionSource ?? '—') }}</TableCell>
        <TableCell>{{ row.runTrigger ?? '—' }}</TableCell>
        <TableCell>{{ row.llmDurationMs != null ? `${row.llmDurationMs} ms` : '—' }}</TableCell>
        <TableCell>{{ formatTokens(row.llmInputTokens, row.llmOutputTokens) }}</TableCell>
        <TableCell>{{ formatCost(row.llmCostUsd, locale) }}</TableCell>
        <TableCell>{{ row.extractionConfidence ?? '—' }}</TableCell>
        <TableCell>{{ props.formatDate(row.createdAt) }}</TableCell>
        <TableCell class="max-w-md text-destructive">{{ row.errorMessage ?? '—' }}</TableCell>
        <TableCell>
          <Button
            v-if="row.version != null && !row.isLatest"
            type="button" size="sm" variant="outline"
            :disabled="props.promotePending === row.version"
            @click="emit('promote', row.version!)"
          >
            {{ $t('settings.auctionTechnical.versions.promote') }}
          </Button>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
  <p v-else class="text-sm text-muted-foreground">{{ $t('settings.auctionTechnical.noData') }}</p>
</template>
